
// --- Initialize map ---
const map = L.map('map').setView([43.6532, -79.3832], 12); // Toronto
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
}).addTo(map);

// --- D3 Overlay -- -
const svg = d3.select(map.getPanes().overlayPane).append("svg").style("pointer-events", "none");
const g = svg.append("g").attr("class", "leaflet-zoom-hide");

map.on("zoom move", () => {
    const bounds = map.getBounds();
    const topLeft = map.latLngToLayerPoint(bounds.getNorthWest());
    const bottomRight = map.latLngToLayerPoint(bounds.getSouthEast());

    svg.attr("width", bottomRight.x - topLeft.x)
        .attr("height", bottomRight.y - topLeft.y)
        .style("left", `${topLeft.x}px`)
        .style("top", `${topLeft.y}px`);

    g.attr("transform", `translate(${-topLeft.x}, ${-topLeft.y})`);
});

// --- Simulation State ---
let isSimulating = false;
let lastFrameTime = null;
let animationFrameId = null;
let showStopMarkers = true;

// --- Colors ---
const normalColor = 'red';
const delayColor = 'blue';
const impactColor = 'orange';
const dailyDelayColor = 'purple';

// --- UI Elements ---
const dateInput = document.getElementById('sim-date');
const timeSlider = document.getElementById('sim-time');
const timeLabel = document.getElementById('sim-time-label');
const startButton = document.getElementById('start-sim');
const speedSlider = document.getElementById('sim-speed');
const toggleStopsButton = document.getElementById('toggle-stops');

// --- Initialize UI ---
const today = new Date();
const now = new Date();
const seconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
timeSlider.value = seconds;
timeLabel.textContent = now.toTimeString().split(' ')[0];
startButton.disabled = true;

// --- Event Listeners ---
timeSlider.addEventListener('input', () => {
    timeLabel.textContent = new Date(timeSlider.value * 1000).toISOString().substr(11, 8);
});

startButton.addEventListener('click', () => {
    if (isSimulating) {
        stopSimulation();
    } else {
        startSimulation();
    }
});

toggleStopsButton.addEventListener('click', () => {
    showStopMarkers = !showStopMarkers;
    if (!showStopMarkers) {
        g.selectAll(".stop").remove();
    }
});

// --- Load GTFS Data ---
loadAllGTFSData().then(() => {
    console.log("GTFS Data Loaded. Ready to simulate.");

    const dateRange = getServiceDateRange();
    if (dateRange) {
        dateInput.min = dateRange.min;
        dateInput.max = dateRange.max;
        dateInput.value = dateRange.min;
    }

    startButton.disabled = false;
    drawColorScale(); // Draw the color scale once data is loaded

    const prevChartButton = document.getElementById('prev-chart');
    const nextChartButton = document.getElementById('next-chart');

    prevChartButton.addEventListener('click', () => {
        if (currentChartType === 'monthly') {
            currentChartType = 'stacked';
        } else {
            currentChartType = 'monthly';
        }
        if (currentRouteShortName && currentRouteData) {
            displayDelayChart(currentRouteShortName, currentRouteData);
        }
    });

    nextChartButton.addEventListener('click', () => {
        if (currentChartType === 'monthly') {
            currentChartType = 'stacked';
        } else {
            currentChartType = 'monthly';
        }
        if (currentRouteShortName && currentRouteData) {
            displayDelayChart(currentRouteShortName, currentRouteData);
        }
    });
});


// --- Simulation ---
let simulationInterval = null;
let currentChartType = 'monthly'; // Default chart type
let currentRouteData = null; // To store data for the currently displayed route
let currentRouteShortName = null; // To store the short name of the currently displayed route

function simulationStep() {
    // --- Time Update ---
    const speed = parseInt(speedSlider.value);
    const timeIncrement = speed * 10; // Increment by 10 seconds per step
    let timeInSeconds = parseInt(timeSlider.value) + timeIncrement;
    if (timeInSeconds >= 86400) {
        timeInSeconds = 0; // Loop the day
    }
    timeSlider.value = timeInSeconds;
    timeLabel.textContent = new Date(timeInSeconds * 1000).toISOString().substr(11, 8);

    // --- Data Update ---
    const selectedDate = new Date(dateInput.value.replace(/-/g, '/'));
    const vehiclePositions = runSimulation(selectedDate, timeInSeconds);
    console.log("vehiclePositions", vehiclePositions.length);

    // --- Render Vehicles ---
    const vehicleSelection = g.selectAll(".vehicle").data(vehiclePositions, d => d.id);

    vehicleSelection.enter()
        .append("circle")
        .attr("class", "vehicle")
        .attr("r", 5)
        .attr("stroke", "white")
        .attr("stroke-width", 1)
        .merge(vehicleSelection)
        .style("pointer-events", "auto")
        .on("mouseover", function() { map.dragging.disable(); map.scrollWheelZoom.disable(); })
        .on("mouseout", function() { map.dragging.enable(); map.scrollWheelZoom.enable(); })
        .on("click", function (event, d) {
            L.DomEvent.stopPropagation(event); // Stop event propagation to Leaflet
            console.log("Vehicle clicked:", d.id);
            const popupContent = `
                <b>Route:</b> ${d.route_id}<br>
                <b>Trip Headsign:</b> ${d.trip_headsign}<br>
                <b>Next Stop:</b> ${d.next_stop}
            `;
            const popup = L.popup()
                .setLatLng([d.lat, d.lon])
                .setContent(popupContent)
                .openOn(map);

            // Draw delay chart for the clicked route
            if (d.route_id) {
                const route = gtfs.routes.get(d.route_id);
                const route_short_name = route ? route.route_short_name : d.route_id;
                const monthlyDelays = getMonthlyDelaysForRoute(route_short_name);
                displayDelayChart(route_short_name, monthlyDelays);
            }

            popup.on('remove', () => {
                clearDelayChart();
            });
        })
        .attr("transform", d => {
            const point = map.latLngToLayerPoint([d.lat, d.lon]);
            return `translate(${point.x},${point.y})`;
        })
        .attr("fill", d => {
            if (d.has_daily_delay) return dailyDelayColor;
            switch (d.delay_status) {
                case 'delayed': return delayColor;
                case 'impacted': return impactColor;
                default: return normalColor;
            }
        });

    vehicleSelection.exit().remove();

    // --- Render Stops ---
    if (showStopMarkers) {
        const bounds = map.getBounds();
        const stopsInView = Array.from(gtfs.stops.values()).filter(stop => {
            const lat = parseFloat(stop.stop_lat);
            const lon = parseFloat(stop.stop_lon);
            const north = bounds.getNorth();
            const south = bounds.getSouth();
            const east = bounds.getEast();
            const west = bounds.getWest();

            return lat <= north && lat >= south && lon <= east && lon >= west;
        });
        console.log("stopsInView", stopsInView.length);
        const stopSelection = g.selectAll(".stop").data(stopsInView, d => d.stop_id);

        stopSelection.enter()
            .append("circle")
            .attr("class", "stop")
            .attr("r", 4)
            .attr("stroke", "white")
            .attr("stroke-width", 1)
            .merge(stopSelection)
            .style("pointer-events", "auto")
            .on("mouseover", function() { map.dragging.disable(); map.scrollWheelZoom.disable(); })
            .on("mouseout", function() { map.dragging.enable(); map.scrollWheelZoom.enable(); })
            .on("click", function (event, d) {
                L.DomEvent.stopPropagation(event); // Stop event propagation to Leaflet
                console.log("Stop clicked:", d.stop_id);
                const nextArrivalInfo = getNextArrivalTimeForStop(d.stop_id, parseInt(timeSlider.value), new Date(dateInput.value.replace(/-/g, '/')));
                let popupContent = `<b>Stop:</b> ${d.stop_name}<br>`;
                if (nextArrivalInfo) {
                    const timeRemaining = nextArrivalInfo.nextArrivalTime - parseInt(timeSlider.value);
                    const minutesRemaining = Math.ceil(timeRemaining / 60);
                    popupContent += `Next vehicle in: ${minutesRemaining} mins`;
                } else {
                    popupContent += `No upcoming vehicles`;
                }
                const popup = L.popup()
                    .setLatLng([d.stop_lat, d.stop_lon])
                    .setContent(popupContent)
                    .openOn(map);

                // Draw delay chart for the next arriving route
                if (nextArrivalInfo && nextArrivalInfo.routeId) {
                    const route = gtfs.routes.get(nextArrivalInfo.routeId);
                    const route_short_name = route ? route.route_short_name : nextArrivalInfo.routeId;
                    const monthlyDelays = getMonthlyDelaysForRoute(route_short_name);
                    displayDelayChart(route_short_name, monthlyDelays);
                }

                popup.on('remove', () => {
                    clearDelayChart();
                });
            })
            .attr("transform", d => {
                const point = map.latLngToLayerPoint([d.stop_lat, d.stop_lon]);
                return `translate(${point.x},${point.y})`;
            })
            .attr("fill", d => {
                const nextArrivalInfo = getNextArrivalTimeForStop(d.stop_id, parseInt(timeSlider.value), new Date(dateInput.value.replace(/-/g, '/')));
                let fillPercentage = 0;
                if (nextArrivalInfo) {
                    const timeRemaining = nextArrivalInfo.nextArrivalTime - parseInt(timeSlider.value);
                    const fixedTimeWindow = 900; // 15 minutes in seconds
                    fillPercentage = Math.max(0, Math.min(1, 1 - (timeRemaining / fixedTimeWindow)));
                }
                const lightness = 80 - (fillPercentage * 60);
                return `hsl(200, 100%, ${lightness}%)`;
            });

        stopSelection.exit().remove();
    } else {
        g.selectAll(".stop").remove();
    }
}

function startSimulation() {
    isSimulating = true;
    startButton.textContent = "Stop Simulation";
    simulationInterval = setInterval(simulationStep, 100);
}

function stopSimulation() {
    isSimulating = false;
    startButton.textContent = "Start Simulation";
    clearInterval(simulationInterval);
}

// --- D3 Charting for Delays ---
const chartContainer = d3.select("#delay-chart-container");
const chartSvg = d3.select("#delay-chart");
const chartTitle = d3.select("#delay-chart-title");

const margin = { top: 20, right: 20, bottom: 30, left: 40 };

function drawDelayChart(routeId, data) {
    chartSvg.selectAll("*").remove(); // Clear previous chart
    chartTitle.text(`Monthly Delays for Route ${routeId}`);

    chartContainer.style("display", "block"); // Show the chart container

    const chartWidth = parseInt(chartContainer.style("width")) - margin.left - margin.right;
    const chartHeight = parseInt(chartContainer.style("height")) - margin.top - margin.bottom - 20; // -20 for title height

    const x = d3.scaleBand().range([0, chartWidth]).padding(0.1);
    const y = d3.scaleLinear().range([chartHeight, 0]);

    x.domain(data.map(d => d.month));
    y.domain([0, d3.max(data, d => d.count)]);

    const g = chartSvg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    g.append("g")
        .attr("class", "axis axis--x")
        .attr("transform", `translate(0,${chartHeight})`)
        .call(d3.axisBottom(x));

    g.append("g")
        .attr("class", "axis axis--y")
        .call(d3.axisLeft(y).ticks(5))
        .append("text")
        .attr("transform", "rotate(-90)")
        .attr("y", 6)
        .attr("dy", "0.71em")
        .attr("text-anchor", "end")
        .text("Delays");

    g.selectAll(".bar")
        .data(data)
        .enter().append("rect")
        .attr("class", "bar")
        .attr("x", d => x(d.month))
        .attr("y", d => y(d.count))
        .attr("width", x.bandwidth())
        .attr("height", d => chartHeight - y(d.count));
}

function drawStackedDelayChart(routeShortName, data) {
    chartSvg.selectAll("*").remove(); // Clear previous chart
    chartTitle.text(`Daily Delays for Route ${routeShortName}`);

    chartContainer.style("display", "block"); // Show the chart container

    const chartWidth = parseInt(chartContainer.style("width")) - margin.left - margin.right;
    const chartHeight = parseInt(chartContainer.style("height")) - margin.top - margin.bottom - 20; // -20 for title height

    const x = d3.scaleBand().range([0, chartWidth]).padding(0.1);
    const y = d3.scaleLinear().range([chartHeight, 0]);

    const keys = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const stack = d3.stack().keys(keys);
    const stackedData = stack(data);

    x.domain(data.map(d => d.month));
    y.domain([0, d3.max(stackedData[stackedData.length - 1], d => d[1])]);

    const color = d3.scaleOrdinal()
        .domain(keys)
        .range(d3.schemeCategory10);

    const g = chartSvg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    g.append("g")
        .attr("class", "axis axis--x")
        .attr("transform", `translate(0,${chartHeight})`)
        .call(d3.axisBottom(x));

    g.append("g")
        .attr("class", "axis axis--y")
        .call(d3.axisLeft(y).ticks(5))
        .append("text")
        .attr("transform", "rotate(-90)")
        .attr("y", 6)
        .attr("dy", "0.71em")
        .attr("text-anchor", "end")
        .text("Delays");

    g.selectAll(".serie")
        .data(stackedData)
        .enter().append("g")
        .attr("fill", d => color(d.key))
        .selectAll("rect")
        .data(d => d)
        .enter().append("rect")
        .attr("x", d => x(d.data.month))
        .attr("y", d => y(d[1]))
        .attr("height", d => y(d[0]) - y(d[1]))
        .attr("width", x.bandwidth());

    // Add legend
    const legend = g.append("g")
        .attr("font-family", "sans-serif")
        .attr("font-size", 10)
        .attr("text-anchor", "end")
        .selectAll("g")
        .data(keys.slice().reverse())
        .enter().append("g")
        .attr("transform", (d, i) => `translate(0,${i * 20})`);

    legend.append("rect")
        .attr("x", chartWidth - 19)
        .attr("width", 19)
        .attr("height", 19)
        .attr("fill", color);

    legend.append("text")
        .attr("x", chartWidth - 24)
        .attr("y", 9.5)
        .attr("dy", "0.32em")
        .text(d => d);
}


function drawStackedDelayChart(routeShortName, data) {
    chartSvg.selectAll("*").remove(); // Clear previous chart
    chartTitle.text(`Daily Delays for Route ${routeShortName}`);

    chartContainer.style("display", "block"); // Show the chart container

    const chartWidth = parseInt(chartContainer.style("width")) - margin.left - margin.right;
    const chartHeight = parseInt(chartContainer.style("height")) - margin.top - margin.bottom - 20; // -20 for title height

    const x = d3.scaleBand().range([0, chartWidth]).padding(0.1);
    const y = d3.scaleLinear().range([chartHeight, 0]);

    const keys = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const stack = d3.stack().keys(keys);
    const stackedData = stack(data);

    x.domain(data.map(d => d.month));
    y.domain([0, d3.max(stackedData[stackedData.length - 1], d => d[1])]);

    const color = d3.scaleOrdinal()
        .domain(keys)
        .range(d3.schemeCategory10);

    const g = chartSvg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    g.append("g")
        .attr("class", "axis axis--x")
        .attr("transform", `translate(0,${chartHeight})`)
        .call(d3.axisBottom(x));

    g.append("g")
        .attr("class", "axis axis--y")
        .call(d3.axisLeft(y).ticks(5))
        .append("text")
        .attr("transform", "rotate(-90)")
        .attr("y", 6)
        .attr("dy", "0.71em")
        .attr("text-anchor", "end")
        .text("Delays");

    g.selectAll(".serie")
        .data(stackedData)
        .enter().append("g")
        .attr("fill", d => color(d.key))
        .selectAll("rect")
        .data(d => d)
        .enter().append("rect")
        .attr("x", d => x(d.data.month))
        .attr("y", d => y(d[1]))
        .attr("height", d => y(d[0]) - y(d[1]))
        .attr("width", x.bandwidth());

    // Add legend
    const legend = g.append("g")
        .attr("font-family", "sans-serif")
        .attr("font-size", 10)
        .attr("text-anchor", "end")
        .selectAll("g")
        .data(keys.slice().reverse())
        .enter().append("g")
        .attr("transform", (d, i) => `translate(0,${i * 20})`);

    legend.append("rect")
        .attr("x", chartWidth - 19)
        .attr("width", 19)
        .attr("height", 19)
        .attr("fill", color);

    legend.append("text")
        .attr("x", chartWidth - 24)
        .attr("y", 9.5)
        .attr("dy", "0.32em")
        .text(d => d);
}


function clearDelayChart() {
    chartContainer.style("display", "none"); // Hide the chart container
    chartSvg.selectAll("*").remove(); // Clear SVG content
    chartTitle.text(""); // Clear title
}

function displayDelayChart(routeShortName, data) {
    currentRouteShortName = routeShortName;
    currentRouteData = data;
    if (currentChartType === 'monthly') {
        const monthlyDelays = getMonthlyDelaysForRoute(routeShortName);
        drawDelayChart(currentRouteShortName, monthlyDelays);
    } else if (currentChartType === 'stacked') {
        const monthlyDelaysByDay = getMonthlyDelaysForRouteByDay(routeShortName);
        drawStackedDelayChart(currentRouteShortName, monthlyDelaysByDay);
    }
}

// --- Color Scale for Stops ---
function drawColorScale() {
    const svg = d3.select("#color-scale-svg");
    const width = +svg.attr("width");
    const height = +svg.attr("height");

    const gradient = svg.append("defs")
        .append("linearGradient")
        .attr("id", "color-gradient")
        .attr("x1", "0%")
        .attr("y1", "0%")
        .attr("x2", "100%")
        .attr("y2", "0%");

    // Define color stops for the gradient
    // Corresponds to fillPercentage from 0 to 1 (light blue to dark blue)
    gradient.append("stop")
        .attr("offset", "0%")
        .attr("stop-color", "hsl(200, 100%, 80%)"); // Light blue (0% fill)
    gradient.append("stop")
        .attr("offset", "100%")
        .attr("stop-color", "hsl(200, 100%, 20%)"); // Dark blue (100% fill)

    // Draw the gradient bar
    svg.append("rect")
        .attr("x", 10)
        .attr("y", 10)
        .attr("width", width - 20)
        .attr("height", 15)
        .style("fill", "url(#color-gradient)");

    // Add labels
    const scale = d3.scaleLinear()
        .domain([0, 15]) // Minutes
        .range([10, width - 10]); // Corresponding pixel range

    svg.selectAll(".scale-label")
        .data([0, 5, 10, 15]) // Labels for 0, 5, 10, 15 minutes
        .enter().append("text")
        .attr("class", "scale-label")
        .attr("x", d => scale(15 - d)) // Position based on minutes remaining (inverse of fillPercentage)
        .attr("y", 40)
        .attr("text-anchor", "middle")
        .style("font-size", "8pt") // Set font size to 8pt
        .text(d => `${d} min`);
}




