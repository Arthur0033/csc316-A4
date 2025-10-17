
// --- Initialize map ---
const map = L.map('map').setView([43.6532, -79.3832], 12); // Toronto
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
}).addTo(map);

// --- Simulation State ---
let vehicleMarkers = {};
let isSimulating = false;
let lastFrameTime = null;
let animationFrameId = null;
let currentRoutePolyline = null; // To hold the currently displayed route shape

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

// --- Initialize UI ---
const today = new Date();
// dateInput.value = today.toISOString().split('T')[0]; // Will be set after data loads
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

// --- Load GTFS Data ---
loadAllGTFSData().then(() => {
    console.log("GTFS Data Loaded. Ready to simulate.");
    console.log("Type of getMonthlyDelaysForRoute:", typeof getMonthlyDelaysForRoute);

    const dateRange = getServiceDateRange();
    if (dateRange) {
        dateInput.min = dateRange.min;
        dateInput.max = dateRange.max;
        dateInput.value = dateRange.min;
    }

    startButton.disabled = false;
});

// --- Simulation ---
function startSimulation() {
    isSimulating = true;
    startButton.textContent = "Stop Simulation";
    lastFrameTime = performance.now();
    animationFrameId = requestAnimationFrame(simulationLoop);
}

function stopSimulation() {
    isSimulating = false;
    startButton.textContent = "Start Simulation";
    cancelAnimationFrame(animationFrameId);
}

function simulationLoop(currentTime) {
    if (!isSimulating) return;

    const elapsed = currentTime - lastFrameTime;
    lastFrameTime = currentTime;

    const speed = parseInt(speedSlider.value);
    const timeIncrement = (elapsed / 1000) * speed;

    let timeInSeconds = parseInt(timeSlider.value) + timeIncrement;
    if (timeInSeconds >= 86400) {
        timeInSeconds = 0; // Loop the day
    }
    timeSlider.value = timeInSeconds;
    timeLabel.textContent = new Date(timeInSeconds * 1000).toISOString().substr(11, 8);

    const selectedDate = new Date(dateInput.value.replace(/-/g, '/'));
    const vehiclePositions = runSimulation(selectedDate, timeInSeconds);
    updateVehiclePositions(vehiclePositions);

    animationFrameId = requestAnimationFrame(simulationLoop);
}

// --- Vehicle Position Update ---
function updateVehiclePositions(data) {
    const activeVehicleIds = new Set();

    data.forEach(vehicle => {
        activeVehicleIds.add(vehicle.id);
        const { id, lat, lon, route_id, trip_headsign, next_stop, delay_status, delay_info, has_daily_delay, shape_id } = vehicle;

        let popupContent = `
            <b>Route:</b> ${route_id}<br>
            <b>Trip Headsign:</b> ${trip_headsign}<br>
            <b>Next Stop:</b> ${next_stop}
        `;

        let color = normalColor;
        if (has_daily_delay) {
            color = dailyDelayColor;
        } else {
            switch (delay_status) {
                case 'delayed':
                    color = delayColor;
                    popupContent += `<br><b>Delay:</b> ${delay_info.description} (${delay_info.duration} mins)`;
                    break;
                case 'impacted':
                    color = impactColor;
                    popupContent += `<br><b>Delay Impact</b>`;
                    break;
            }
        }

        if (vehicleMarkers[id]) {
            vehicleMarkers[id].setLatLng([lat, lon]);
            vehicleMarkers[id].setStyle({fillColor: color});
            vehicleMarkers[id].getPopup().setContent(popupContent);
            vehicleMarkers[id].shape_id = shape_id; // Update shape_id on existing marker
        } else {
            const marker = L.circleMarker([lat, lon], {
                radius: 5,
                fillColor: color,
                color: 'white',
                weight: 1,
                fillOpacity: 1,
            }).addTo(map);

            marker.shape_id = shape_id; // Store shape_id on the marker
            marker.route_id = route_id; // Store route_id on the marker

            marker.bindPopup(popupContent); // Bind popup first

            marker.on('popupopen', (e) => {
                if (currentRoutePolyline) {
                    map.removeLayer(currentRoutePolyline);
                }
                const openedMarker = e.popup._source; // Get the marker that opened the popup
                const clickedShapeId = openedMarker.shape_id;
                const clickedRouteId = openedMarker.route_id; // Get route_id from marker
                console.log('Clicked marker shape_id:', clickedShapeId);
                if (clickedShapeId) { // Check if shape_id exists
                    const shapePoints = getShapePoints(clickedShapeId);
                    console.log('Shape points for', clickedShapeId, ':', shapePoints);
                    if (shapePoints && shapePoints.length > 0) {
                        const latLngs = shapePoints.map(p => [parseFloat(p.shape_pt_lat), parseFloat(p.shape_pt_lon)]);
                        currentRoutePolyline = L.polyline(latLngs, { color: 'green', weight: 3 }).addTo(map);

                        // Draw delay chart for the clicked route
                        if (clickedRouteId) {
                            const monthlyDelays = getMonthlyDelaysForRoute(clickedRouteId);
                            drawDelayChart(clickedRouteId, monthlyDelays);
                        }
                    } else {
                        console.log('No shape points found or shapePoints is empty for shape_id:', clickedShapeId);
                    }
                } else {
                    console.log('No shape_id found for clicked marker.');
                }
            });

            marker.on('popupclose', () => {
                if (currentRoutePolyline) {
                    map.removeLayer(currentRoutePolyline);
                    currentRoutePolyline = null;
                }
                clearDelayChart();
            });

            vehicleMarkers[id] = marker;
        }
    });

    // Remove markers for vehicles that are no longer active
    for (const id in vehicleMarkers) {
        if (!activeVehicleIds.has(id)) {
            map.removeLayer(vehicleMarkers[id]);
            delete vehicleMarkers[id];
        }
    }
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

function clearDelayChart() {
    chartContainer.style("display", "none"); // Hide the chart container
    chartSvg.selectAll("*").remove(); // Clear SVG content
    chartTitle.text(""); // Clear title
}

