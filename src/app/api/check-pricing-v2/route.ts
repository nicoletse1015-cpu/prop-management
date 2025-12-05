import { NextRequest, NextResponse } from 'next/server';
import { getPropertyWithDb, getPriceCalendarWithDb } from '@/lib/pricing/pricing-with-db';
import { getMonthsBetweenDates } from '@/lib/pricing/price-calendar-generator';
import { calculateBookingPrice, LengthOfStayDiscount } from '@/lib/pricing/price-calculation';
import { differenceInDays, format, addDays, parseISO } from 'date-fns';
import { checkAvailabilityWithFlags } from '@/lib/availability-service';

/**
 * API endpoint to check availability and pricing using the availability collection
 * 
 * This endpoint uses the availability collection as the single source of truth
 * for availability data, which provides better consistency and performance.
 */
export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const body = await request.json();
    const { propertyId, checkIn, checkOut, guests } = body;
    
    // Validate required parameters
    if (!propertyId || !checkIn || !checkOut || !guests) {
      return NextResponse.json(
        { error: 'Missing required parameters' },
        { status: 400 }
      );
    }
    
    // Parse dates
    const checkInDate = parseISO(checkIn);
    const checkOutDate = parseISO(checkOut);
    
    // Validate past dates
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (checkInDate < today) {
      return NextResponse.json(
        { error: 'Check-in date cannot be in the past' },
        { status: 400 }
      );
    }
    
    // Validate date range
    if (checkInDate >= checkOutDate) {
      return NextResponse.json(
        { error: 'Check-out date must be after check-in date' },
        { status: 400 }
      );
    }
    
    // Get property details
    const property = await getPropertyWithDb(propertyId);
    
    // Log property for debugging
    console.log(`[check-pricing-v2] 🏠 Property details for ${propertyId}:`, {
      baseOccupancy: property.baseOccupancy,
      extraGuestFee: property.extraGuestFee,
      pricePerNight: property.pricePerNight
    });

    // Log availability service being used
    console.log(`[check-pricing-v2] 🚩 Using availability collection (single source)`);
    
    // Get number of nights
    const nights = differenceInDays(checkOutDate, checkInDate);
    
    // Use availability service (single source)
    console.log(`[check-pricing-v2] 🔍 Checking availability using availability collection...`);
    const availabilityResult = await checkAvailabilityWithFlags(propertyId, checkInDate, checkOutDate);
    
    console.log(`[check-pricing-v2] 📊 Availability result:`, {
      isAvailable: availabilityResult.isAvailable,
      source: availabilityResult.source,
      unavailableDatesCount: availabilityResult.unavailableDates.length
    });

    // If dates are not available, return early
    if (!availabilityResult.isAvailable) {
      return NextResponse.json({
        available: false,
        reason: 'unavailable_dates',
        unavailableDates: availabilityResult.unavailableDates,
        meta: {
          source: availabilityResult.source
        }
      });
    }

    // Get price calendars for pricing calculation (still needed for pricing data)
    console.log(`[check-pricing-v2] 💰 Getting price calendars for pricing calculation...`);
    const months = getMonthsBetweenDates(checkInDate, checkOutDate);
    const calendars = await Promise.all(
      months.map(async ({ year, month }) => {
        const calendar = await getPriceCalendarWithDb(propertyId, year, month);
        return calendar;
      })
    );
    
    // Check if any calendars are missing
    if (calendars.some(calendar => calendar === null)) {
      return NextResponse.json(
        { error: 'Price information not available for the selected dates' },
        { status: 404 }
      );
    }
    
    // Calculate pricing for each date
    const dailyPrices: Record<string, number> = {};
    let minimumStay = (property as any).defaultMinimumStay ?? 1;
    
    // Check each day for pricing
    const currentDate = new Date(checkInDate);
    console.log(`[check-pricing-v2] 🧮 Calculating pricing for ${nights} nights from ${format(checkInDate, 'yyyy-MM-dd')}`);
    
    for (let night = 0; night < nights; night++) {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth() + 1;
      const day = currentDate.getDate().toString();
      
      // Find the relevant calendar
      const calendar = calendars.find(c => c?.year === year && c?.month === month);
      
      if (!calendar || !calendar.days[day]) {
        return NextResponse.json(
          { error: `Price information not available for ${dateStr}` },
          { status: 404 }
        );
      }

      const dayPrice = calendar.days[day];
      
      // Calculate price for this date
      console.log(`[check-pricing-v2] 🧮 Calculating price for ${dateStr} with ${guests} guests`);
      
      if (guests <= property.baseOccupancy) {
        console.log(`[check-pricing-v2] ✅ Using basePrice: ${dayPrice.basePrice}`);
        dailyPrices[dateStr] = dayPrice.basePrice;
      } else {
        const occupancyPrice = dayPrice.prices?.[guests.toString()];
        console.log(`[check-pricing-v2] 🔍 Checking for specific price for ${guests} guests:`, 
          occupancyPrice ? `Found: ${occupancyPrice}` : 'Not found, using fallback');
        
        if (occupancyPrice) {
          dailyPrices[dateStr] = occupancyPrice;
        } else {
          // Fallback to base price + extra guest fee
          const extraGuests = guests - property.baseOccupancy;
          const extraGuestFee = property.extraGuestFee || 0;
          const calculatedPrice = dayPrice.basePrice + (extraGuests * extraGuestFee);
          
          console.log(`[check-pricing-v2] 📊 Fallback calculation: ${dayPrice.basePrice} + (${extraGuests} × ${extraGuestFee}) = ${calculatedPrice}`);
          dailyPrices[dateStr] = calculatedPrice;
        }
      }
      
      // Check minimum stay for all nights - use the highest value found
      if (dayPrice.minimumStay && dayPrice.minimumStay > minimumStay) {
        minimumStay = dayPrice.minimumStay;
      }
      
      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Check if minimum stay requirement is met
    console.log(`[check-pricing-v2] 🏗️ Minimum stay validation: ${nights} nights >= ${minimumStay} minimum = ${nights >= minimumStay}`);
    const meetsMinimumStay = nights >= minimumStay;
    
    if (!meetsMinimumStay) {
      return NextResponse.json({
        available: false,
        reason: 'minimum_stay',
        minimumStay,
        requiredNights: minimumStay,
        meta: {
          source: availabilityResult.source
        }
      });
    }

    // Calculate booking price with any applicable discounts
    const pricingDetails = calculateBookingPrice(
      dailyPrices,
      (property as any).cleaningFee || 0,
      property.pricingConfig?.lengthOfStayDiscounts as LengthOfStayDiscount[]
    );
    
    // Final response with metadata
    const finalResponse = {
      available: true,
      pricing: {
        ...pricingDetails,
        dailyRates: dailyPrices,
        currency: property.baseCurrency
      },
      meta: {
        source: availabilityResult.source
      }
    };
    
    // Log the complete pricing response for debugging
    console.log(`[check-pricing-v2] 📊 Final pricing response for ${guests} guests:`, {
      subtotal: finalResponse.pricing.subtotal,
      totalPrice: finalResponse.pricing.totalPrice,
      total: finalResponse.pricing.total,
      averageNightlyRate: finalResponse.pricing.accommodationTotal / finalResponse.pricing.numberOfNights,
      source: finalResponse.meta.source
    });
    
    return NextResponse.json(finalResponse);

  } catch (error) {
    console.error('[check-pricing-v2] Error checking pricing:', error);
    return NextResponse.json(
      { 
        error: 'Failed to check pricing',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
