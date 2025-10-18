

// --- GTFS Data Loading ---
const DATA_URL = 'http://localhost:8000/static_data/';

async function loadCSV(fileName) {
    try {
        const response = await fetch(`${DATA_URL}${fileName}`);
        const text = await response.text();
        console.log(`Loaded ${fileName}. Text length: ${text.length}`); // ADD LOG
        // Super simple CSV parser
        const lines = text.trim().split('\n');
        console.log(`Parsed ${fileName}. Number of lines: ${lines.length}`); // ADD LOG
        const headers = lines[0].split(',').map(h => h.trim());
        console.log(`loadCSV: Headers for ${fileName}:`, headers); // ADD LOG
        const parsedData = lines.slice(1).map(line => {
            const values = line.split(',');
            const rowObject = headers.reduce((obj, header, index) => {
                const value = values[index];
                obj[header] = (value !== undefined && value !== null) ? value.trim() : '';
                if (header === 'Date' && (value === undefined || value === null)) {
                    console.warn(`Warning: 'Date' value is undefined or null for row: ${line}`);
                }
                return obj;
            }, {});
            return rowObject;
        });
        console.log(`loadCSV: Parsed data for ${fileName} (first 5 rows):`, parsedData.slice(0, 5)); // ADD LOG
        return parsedData;
    } catch (error) {
        console.error(`Error loading ${fileName}:`, error);
        console.error(`Failed to load ${fileName}. Returning empty array.`, error); // ADD MORE INFO HERE
        return [];
    }
}

// --- Data Storage ---
const gtfs = {
    stops: new Map(),
    stop_times: new Map(),
    trips: new Map(),
    routes: new Map(),
    shapes: new Map(), // To store shape data
    calendar: [],
    calendar_dates: [],
    delays: new Map(),
    delay_codes: new Map(),
    stop_arrivals: new Map(), // New: To store pre-processed stop arrival data
};

// --- Load all data ---
async function loadAllGTFSData() {
    console.log("Loading GTFS data...");
    const stopTimesPromises = [];
    for (let i = 1; i <= 12; i++) {
        stopTimesPromises.push(loadCSV(`stop_times_part_${i}.txt`));
    }

    const [stops, allStopTimesParts, trips, routes, calendar, calendar_dates, bus_delays, streetcar_delays, code_descriptions, shapes] = await Promise.all([
        loadCSV('stops.txt'),
        Promise.all(stopTimesPromises), // Load all stop_times parts concurrently
        loadCSV('trips.txt'),
        loadCSV('routes.txt'),
        loadCSV('calendar.txt'),
        loadCSV('calendar_dates.txt'),
        loadCSV('Bus_delay2025.csv'),
        loadCSV('StreetCar_delay2025.csv'),
        loadCSV('Code_Descriptions.csv'),
        loadCSV('shapes.txt'),
    ]);

    // Flatten the array of arrays for stop_times
    const stop_times = allStopTimesParts.flat();

    for (const stop of stops) {
        gtfs.stops.set(stop.stop_id, stop);
    }

    for (const stop_time of stop_times) {
        if (!gtfs.stop_times.has(stop_time.trip_id)) {
            gtfs.stop_times.set(stop_time.trip_id, []);
        }
        gtfs.stop_times.get(stop_time.trip_id).push(stop_time);
    }

    for (const trip of trips) {
        gtfs.trips.set(trip.trip_id, trip);
    }
    
    for (const route of routes) {
        gtfs.routes.set(route.route_id, route);
    }

    gtfs.calendar = calendar;
    gtfs.calendar_dates = calendar_dates;

    for (const code of code_descriptions) {
        gtfs.delay_codes.set(code.CODE, code.DESCRIPTION);
    }

    const all_delays = bus_delays.concat(streetcar_delays);
    for (const delay of all_delays) {
        if (delay.Date === undefined) {
            console.error("Error: delay.Date is undefined for delay object:", delay);
        }
        const date = delay.Date.split('T')[0];
        const route_num_match = delay.Line.match(/^\d+/);
        if (route_num_match) {
            const route_num = route_num_match[0];
            //console.log("Extracted route number from delay file:", route_num);
            if (!gtfs.delays.has(route_num)) {
                gtfs.delays.set(route_num, new Map());
            }
            if (!gtfs.delays.get(route_num).has(date)) {
                gtfs.delays.get(route_num).set(date, []);
            }
            gtfs.delays.get(route_num).get(date).push(delay);
        }
    }


    // Sort stop_times by sequence
    for (const [trip_id, stop_times] of gtfs.stop_times.entries()) {
        stop_times.sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence));
    }

    // Populate gtfs.stop_arrivals for efficient lookup
    for (const [trip_id, stop_times_for_trip] of gtfs.stop_times.entries()) {
        const trip = gtfs.trips.get(trip_id);
        if (!trip) continue; // Should not happen if data is consistent

        for (const stop_time of stop_times_for_trip) {
            const stop_id = stop_time.stop_id;
            if (!gtfs.stop_arrivals.has(stop_id)) {
                gtfs.stop_arrivals.set(stop_id, []);
            }
            gtfs.stop_arrivals.get(stop_id).push({
                arrival_time_seconds: timeToSeconds(stop_time.arrival_time),
                trip_id: trip_id,
                route_id: trip.route_id,
                service_id: trip.service_id,
            });
        }
    }

    // Sort arrivals for each stop by time
    for (const arrivals of gtfs.stop_arrivals.values()) {
        arrivals.sort((a, b) => a.arrival_time_seconds - b.arrival_time_seconds);
    }

    // Process shapes data
    for (const shape_pt of shapes) {
        if (!gtfs.shapes.has(shape_pt.shape_id)) {
            gtfs.shapes.set(shape_pt.shape_id, []);
        }
        gtfs.shapes.get(shape_pt.shape_id).push(shape_pt);
    }

    console.log("GTFS data loaded and processed.", gtfs);
}

// --- Simulation Logic ---

// Function to get active trips for a given date
function getActiveTrips(date) {
    const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()];
    const dateStr = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`;

    const addedServices = gtfs.calendar_dates
        .filter(cd => cd.date === dateStr && cd.exception_type === '1')
        .map(cd => cd.service_id);

    const removedServices = gtfs.calendar_dates
        .filter(cd => cd.date === dateStr && cd.exception_type === '2')
        .map(cd => cd.service_id);

    const activeServices = new Set(
        gtfs.calendar
            .filter(c => {
                const startDate = c.start_date;
                const endDate = c.end_date;
                return dateStr >= startDate && dateStr <= endDate && c[dayOfWeek] === '1' && !removedServices.includes(c.service_id);
            })
            .map(c => c.service_id)
            .concat(addedServices)
    );

    const activeTrips = [];
    for (const trip of gtfs.trips.values()) {
        if (activeServices.has(trip.service_id)) {
            activeTrips.push(trip);
        }
    }
    return activeTrips;
}


// Function to get the overall service date range from calendar.txt
function getServiceDateRange() {
    if (gtfs.calendar.length === 0) {
        return null;
    }

    let minDate = '99999999';
    let maxDate = '00000000';

    for (const service of gtfs.calendar) {
        if (service.start_date < minDate) {
            minDate = service.start_date;
        }
        if (service.end_date > maxDate) {
            maxDate = service.end_date;
        }
    }
    
    // The date format in calendar.txt is YYYYMMDD, but the date picker needs YYYY-MM-DD
    const formatDate = (dateStr) => {
        return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    };

    return {
        min: formatDate(minDate),
        max: formatDate(maxDate),
    };
}


// Function to get vehicle position at a given time
function getVehiclePosition(trip, timeInSeconds, date) {
    const stopTimes = gtfs.stop_times.get(trip.trip_id);

    if (!stopTimes || stopTimes.length === 0) return null;

    // Find the two stops the vehicle is between
    let fromStop = null;
    let toStop = null;
    for (let i = 0; i < stopTimes.length - 1; i++) {
        const departureTime = timeToSeconds(stopTimes[i].departure_time);
        const arrivalTime = timeToSeconds(stopTimes[i + 1].arrival_time);

        if (timeInSeconds >= departureTime && timeInSeconds <= arrivalTime) {
            fromStop = stopTimes[i];
            toStop = stopTimes[i+1];
            break;
        }
    }

    // If not between stops, check if it's at the last stop
    if (!fromStop || !toStop) {
        const lastStopTime = stopTimes[stopTimes.length - 1];
        if (timeInSeconds >= timeToSeconds(lastStopTime.arrival_time)) {
            const lastStopData = gtfs.stops.get(lastStopTime.stop_id);
            if (!lastStopData) return null;
            return {
                id: trip.trip_id,
                route_id: trip.route_id,
                lat: parseFloat(lastStopData.stop_lat),
                lon: parseFloat(lastStopData.stop_lon),
                trip_headsign: trip.trip_headsign,
                next_stop: "End of Trip",
                delay_status: 'none',
            };
        }
        return null; // Not on trip yet
    }

    // Interpolate position
    const fromStopTime = timeToSeconds(fromStop.departure_time);
    const toStopTime = timeToSeconds(toStop.arrival_time);
    const totalTime = toStopTime - fromStopTime;
    const elapsedTime = timeInSeconds - fromStopTime;
    const progress = totalTime > 0 ? elapsedTime / totalTime : 0;

    const fromStopData = gtfs.stops.get(fromStop.stop_id);
    const toStopData = gtfs.stops.get(toStop.stop_id);

    if (!fromStopData || !toStopData) return null;

    const lat = parseFloat(fromStopData.stop_lat) + (parseFloat(toStopData.stop_lat) - parseFloat(fromStopData.stop_lat)) * progress;
    const lon = parseFloat(fromStopData.stop_lon) + (parseFloat(toStopData.stop_lon) - parseFloat(fromStopData.stop_lon)) * progress;

    const route = gtfs.routes.get(trip.route_id);
    const route_short_name = route ? route.route_short_name : '';
    //console.log("Checking for delays for route:", route_short_name);

    // NEW: Check for any delay on this route for the whole day
    const has_daily_delay = hasDelayForRouteOnDate(route_short_name, date);

    // Check for delays
    let delay_status = 'none';
    let delay_info = null;
    const dateStr = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
    if (gtfs.delays.has(route_short_name) && gtfs.delays.get(route_short_name).has(dateStr)) {
        const delays_for_route_date = gtfs.delays.get(route_short_name).get(dateStr);
        for (const delay of delays_for_route_date) {
            const delay_time_seconds = timeToSeconds(delay.Time);
            const delay_duration_seconds = parseInt(delay['Min Delay']) * 60;
            const impact_duration_seconds = 300 * 60;
            //const impact_duration_seconds = 30 * 60;

            if (timeInSeconds >= delay_time_seconds && timeInSeconds <= delay_time_seconds + delay_duration_seconds) {
                delay_status = 'delayed';
                delay_info = {
                    code: delay.Code,
                    description: gtfs.delay_codes.get(delay.Code),
                    duration: delay['Min Delay']
                };
                break;
            } else if (timeInSeconds > delay_time_seconds + delay_duration_seconds && timeInSeconds <= delay_time_seconds + delay_duration_seconds + impact_duration_seconds) {
                delay_status = 'impacted';
                delay_info = {
                    code: delay.Code,
                    description: gtfs.delay_codes.get(delay.Code),
                    duration: delay['Min Delay']
                };
                break;
            }
        }
    }

    return {
        id: trip.trip_id,
        route_id: route_short_name,
        shape_id: trip.shape_id, // Add shape_id
        lat: lat,
        lon: lon,
        trip_headsign: trip.trip_headsign,
        next_stop: toStopData.stop_name,
        delay_status: delay_status,
        delay_info: delay_info,
        has_daily_delay: has_daily_delay,
    };
}

function getShapePoints(shape_id) {
    const points = gtfs.shapes.get(shape_id);
    console.log('getShapePoints called for shape_id:', shape_id, 'Result:', points); // ADD LOG
    return points || null;
}

function hasDelayForRouteOnDate(route_short_name, date) {
    const dateStr = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
    return gtfs.delays.has(route_short_name) && gtfs.delays.get(route_short_name).has(dateStr);
}

function getMonthlyDelaysForRoute(route_short_name) {
    const monthlyDelays = Array(12).fill(0);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

    const delaysForRoute = gtfs.delays.get(route_short_name);

    if (delaysForRoute) {
        for (const [dateStr, delays] of delaysForRoute.entries()) {
            const month = parseInt(dateStr.substring(5, 7)) - 1; // 0-indexed month
            monthlyDelays[month] += delays.length;
        }
    }

    return monthlyDelays.map((count, index) => ({
        month: monthNames[index],
        delay_count: count
    }));
}

function getMonthlyDelaysForRoute(route_short_name) {
    const monthlyDelays = Array(12).fill(0);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const delaysForRoute = gtfs.delays.get(route_short_name);

    if (delaysForRoute) {
        for (const [dateStr, delays] of delaysForRoute.entries()) {
            // dateStr is in YYYY-MM-DD format
            const month = parseInt(dateStr.substring(5, 7)) - 1; // 0-indexed month
            monthlyDelays[month] += delays.length;
        }
    }

    return monthlyDelays.map((count, index) => ({ month: monthNames[index], count: count }));
}

function getMonthlyDelaysForRouteByDay(route_short_name) {
    const monthlyDelays = Array(12).fill(0).map(() => ({
        month: "",
        sunday: 0,
        monday: 0,
        tuesday: 0,
        wednesday: 0,
        thursday: 0,
        friday: 0,
        saturday: 0,
        total: 0
    }));
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

    const delaysForRoute = gtfs.delays.get(route_short_name);

    if (delaysForRoute) {
        for (const [dateStr, delays] of delaysForRoute.entries()) {
            const date = new Date(dateStr);
            const month = date.getMonth(); // 0-indexed month
            const dayOfWeek = date.getDay(); // 0 for Sunday, 1 for Monday, etc.

            monthlyDelays[month][dayNames[dayOfWeek]] += delays.length;
            monthlyDelays[month].total += delays.length;
        }
    }

    return monthlyDelays.map((data, index) => {
        data.month = monthNames[index];
        return data;
    });
}

function getNextArrivalTimeForStop(stopId, currentSimulationTime, currentDate) {
    const arrivalsAtStop = gtfs.stop_arrivals.get(stopId);
    if (!arrivalsAtStop) {
        // console.log(`Stop ${stopId}: No arrivals data.`); // Debug log
        return null; // No arrivals for this stop
    }

    const dateStr = `${currentDate.getFullYear()}${(currentDate.getMonth() + 1).toString().padStart(2, '0')}${currentDate.getDate().toString().padStart(2, '0')}`;

    // Cache active services for the current date
    const activeServicesForDate = getActiveServicesForDate(currentDate);
    // console.log(`Stop ${stopId}: Active services for ${dateStr}:`, activeServicesForDate); // Debug log

    for (const arrival of arrivalsAtStop) {
        // console.log(`Stop ${stopId}: Checking arrival at ${arrival.arrival_time_seconds}, trip ${arrival.trip_id}, service ${arrival.service_id}`); // Debug log
        // Check if the service for this arrival is active today
        if (!activeServicesForDate.has(arrival.service_id)) {
            // console.log(`Stop ${stopId}: Service ${arrival.service_id} not active.`); // Debug log
            continue;
        }

        if (arrival.arrival_time_seconds > currentSimulationTime) {
            // console.log(`Stop ${stopId}: Found next arrival at ${arrival.arrival_time_seconds} (sim time: ${currentSimulationTime})`); // Debug log
            return {
                nextArrivalTime: arrival.arrival_time_seconds,
                tripId: arrival.trip_id,
                routeId: arrival.route_id
            };
        }
    }

    // console.log(`Stop ${stopId}: No upcoming vehicle after ${currentSimulationTime}.`); // Debug log
    return null; // No upcoming vehicle for this stop
}

// Helper function to cache active services for a given date
const activeServicesCache = new Map(); // Cache for active services

function getActiveServicesForDate(date) {
    const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD
    if (activeServicesCache.has(dateKey)) {
        return activeServicesCache.get(dateKey);
    }

    const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()];
    const dateStr = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`;

    const addedServices = gtfs.calendar_dates
        .filter(cd => cd.date === dateStr && cd.exception_type === '1')
        .map(cd => cd.service_id);

    const removedServices = gtfs.calendar_dates
        .filter(cd => cd.date === dateStr && cd.exception_type === '2')
        .map(cd => cd.service_id);

    const activeServices = new Set(
        gtfs.calendar
            .filter(c => {
                const startDate = c.start_date;
                const endDate = c.end_date;
                return dateStr >= startDate && dateStr <= endDate && c[dayOfWeek] === '1' && !removedServices.includes(c.service_id);
            })
            .map(c => c.service_id)
            .concat(addedServices)
    );
    activeServicesCache.set(dateKey, activeServices);
    return activeServices;
}

// --- Helper function to convert HH:MM:SS to seconds ---
function timeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const [h, m, s] = timeStr.split(':').map(Number);
    return h * 3600 + m * 60 + s;
}

// --- Main simulation function ---
function runSimulation(date, timeInSeconds) {
    console.log(`Running simulation for date: ${date} and time: ${timeInSeconds}`);
    let activeTrips = getActiveTrips(date);
    const vehiclePositions = [];

    // Filter activeTrips to only include routes 1, 2, and 500-600 series
    activeTrips = activeTrips.filter(trip => {
        const route = gtfs.routes.get(trip.route_id);
        if (!route) return false;
        const route_short_name = route.route_short_name;

        // Check for routes 1, 2
        if (route_short_name === '1' || route_short_name === '2') {
            return true;
        }

        // Check for 500-600 series
        const routeNum = parseInt(route_short_name);
        if (!isNaN(routeNum) && routeNum >= 500 && routeNum <= 600) {
            return true;
        }

        return true;
    });

    for (const trip of activeTrips) {
        const position = getVehiclePosition(trip, timeInSeconds, date);
        if (position) {
            vehiclePositions.push(position);
        }
    }

    // Handle overnight trips from the previous day
    const yesterday = new Date(date);
    yesterday.setDate(date.getDate() - 1);
    const activeTripsYesterday = getActiveTrips(yesterday);
    const timeInSecondsForYesterdayTrips = timeInSeconds + 86400; // 24 hours in seconds

    for (const trip of activeTripsYesterday) {
        const stopTimes = gtfs.stop_times.get(trip.trip_id);
        if (stopTimes && stopTimes.length > 0) {
            const lastStopTime = stopTimes[stopTimes.length - 1].arrival_time;
            if (timeToSeconds(lastStopTime) > 86400) {
                const position = getVehiclePosition(trip, timeInSecondsForYesterdayTrips, yesterday);
                if (position) {
                    vehiclePositions.push(position);
                }
            }
        }
    }

    console.log(`Returning ${vehiclePositions.length} vehicle positions.`);
    return vehiclePositions;
}

