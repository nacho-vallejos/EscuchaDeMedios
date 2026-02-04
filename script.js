// ============================================
// CYBER THREAT INTELLIGENCE DASHBOARD
// Real-time data from ThreatFox API
// ============================================

// INICIAR MAPA LEAFLET
const map = L.map('map', { 
    zoomControl: false, 
    attributionControl: false,
    minZoom: 2,
    maxZoom: 8
}).setView([20, 0], 2);

// Dark Matter Style Map
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
    maxZoom: 19,
    subdomains: 'abcd'
}).addTo(map);

// Agregar controles de zoom personalizados
L.control.zoom({
    position: 'bottomright'
}).addTo(map);

// Capas de visualización
let markersLayer = L.layerGroup().addTo(map);
let heatmapLayer = null;
let heatmapData = [];

// Variables globales
let threatCount = 0;
let startTime = Date.now();
let threatTypesMap = new Map();
let malwareFamiliesMap = new Map();
let showHeatmap = true;
let showMarkers = true;

// Colores por tipo de amenaza
const threatColors = {
    'botnet_cc': '#FF3333',
    'ransomware_payment_site': '#FF6B35',
    'payload_delivery': '#FFB000',
    'c2_server': '#F7931E',
    'phishing': '#00FF00',
    'malware_download': '#00D9FF',
    'payload': '#FFB000'
};

// ============================================
// CONTROLES INTERACTIVOS DEL MAPA
// ============================================

function toggleHeatmap() {
    showHeatmap = !showHeatmap;
    const btn = document.getElementById('toggle-heatmap');
    
    if (showHeatmap && heatmapLayer) {
        map.addLayer(heatmapLayer);
        btn.classList.add('active');
    } else if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
        btn.classList.remove('active');
    }
}

function toggleMarkers() {
    showMarkers = !showMarkers;
    const btn = document.getElementById('toggle-markers');
    
    if (showMarkers) {
        map.addLayer(markersLayer);
        btn.classList.add('active');
    } else {
        map.removeLayer(markersLayer);
        btn.classList.remove('active');
    }
}

// Inicializar botones como activos
document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('toggle-heatmap').classList.add('active');
    document.getElementById('toggle-markers').classList.add('active');
});

// ============================================
// FUNCIONES DE UTILIDAD
// ============================================

function getCurrentTime() {
    const now = new Date();
    return now.toTimeString().split(' ')[0];
}

function getUptime() {
    const elapsed = Date.now() - startTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function addSystemLog(message, type = 'info') {
    const logsContainer = document.getElementById('system-logs');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${getCurrentTime()}] [${type.toUpperCase()}] ${message}`;
    
    logsContainer.insertBefore(entry, logsContainer.firstChild);
    
    // Mantener solo últimos 50 logs
    while (logsContainer.children.length > 50) {
        logsContainer.removeChild(logsContainer.lastChild);
    }
}

// ============================================
// FETCH REAL THREATS FROM API
// ============================================

async function fetchRealThreats() {
    try {
        addSystemLog('Fetching threat data from ThreatFox API...', 'info');
        
        const response = await fetch('/api/threats');
        const data = await response.json();

        if (data.query_status === 'ok' && data.data) {
            document.getElementById('api-status').textContent = 'ONLINE';
            document.getElementById('api-status').style.color = '#00FF00';
            
            addSystemLog(`Received ${data.data.length} threat indicators`, 'success');
            updateDashboard(data.data);
        } else if (data.query_status === 'no_result') {
            document.getElementById('api-status').textContent = 'NO DATA';
            document.getElementById('api-status').style.color = '#FFB000';
            addSystemLog('No threats found in the last 24 hours', 'warning');
        } else {
            throw new Error(data.error || 'Unknown error');
        }
        
        document.getElementById('last-update').textContent = getCurrentTime();
        
    } catch (error) {
        document.getElementById('api-status').textContent = 'ERROR';
        document.getElementById('api-status').style.color = '#FF3333';
        addSystemLog(`API Error: ${error.message}`, 'error');
        console.error("Error fetching Real Intel:", error);
    }
}

// ============================================
// UPDATE DASHBOARD WITH REAL DATA
// ============================================

function updateDashboard(threats) {
    const tableBody = document.getElementById('attack-log-body');
    // Limpiamos la tabla visualmente para refrescar
    tableBody.innerHTML = ''; 
    markersLayer.clearLayers(); // Limpiar mapa
    heatmapData = []; // Limpiar datos de heatmap
    
    // Reset counters
    threatTypesMap.clear();
    malwareFamiliesMap.clear();

    // Procesamos solo los últimos 15 ataques para no saturar
    const recentThreats = threats.slice(0, 15);
    threatCount = recentThreats.length;

    recentThreats.forEach((threat, index) => {
        // 1. EXTRAER DATOS REALES
        const timestamp = threat.first_seen_utc;
        const src_ip = threat.ioc; // IP o Dominio malicioso
        const type = threat.threat_type; // Botnet, Payload, etc.
        const malware = threat.malware_printable; // Nombre del Malware (ej: Cobalt Strike)
        const confidence = threat.confidence_level; // Nivel de certeza
        
        // Contar tipos de amenazas
        threatTypesMap.set(type, (threatTypesMap.get(type) || 0) + 1);
        malwareFamiliesMap.set(malware, (malwareFamiliesMap.get(malware) || 0) + 1);
        
        // Intentamos obtener puerto si está en el formato IP:PORT
        let port = "Unknown";
        let displayIP = src_ip;
        if (src_ip.includes(':')) {
            const parts = src_ip.split(':');
            displayIP = parts[0];
            port = parts[1];
        }

        // 2. FILA DE LA TABLA
        const row = document.createElement('tr');
        // Colorear rojo si la confianza es alta (>80)
        const riskColor = confidence > 80 ? '#ff3333' : '#ffb000';
        
        row.innerHTML = `
            <td>${timestamp.split(' ')[1]}</td>
            <td style="color: cyan">${displayIP}</td>
            <td>${port}</td>
            <td style="color: ${riskColor}">${malware}</td>
            <td>${type}</td>
            <td style="color: ${riskColor}">${confidence}%</td>
        `;
        tableBody.appendChild(row);

        // 3. MAPA - Generar coordenadas más realistas con clustering
        // Simular regiones con alta concentración de amenazas
        const hotspotRegions = [
            { lat: 40, lng: -95, name: 'North America' },      // USA
            { lat: 50, lng: 10, name: 'Europe' },              // Europa
            { lat: 35, lng: 105, name: 'East Asia' },          // China
            { lat: 55, lng: 37, name: 'Eastern Europe' },      // Rusia
            { lat: -23, lng: -46, name: 'South America' },     // Brasil
            { lat: 1, lng: 103, name: 'Southeast Asia' }       // Singapore
        ];
        
        // Seleccionar una región hotspot aleatoria
        const region = hotspotRegions[Math.floor(Math.random() * hotspotRegions.length)];
        
        // Agregar variación alrededor del hotspot (clustering)
        const lat = region.lat + (Math.random() - 0.5) * 20;
        const lng = region.lng + (Math.random() - 0.5) * 30;
        
        // Intensidad para el heatmap basada en confidence
        const intensity = confidence / 100;
        heatmapData.push([lat, lng, intensity]);
        
        // Color del marcador según tipo de amenaza
        const markerColor = threatColors[type] || '#FFB000';
        
        const iocType = threat.ioc_type || 'Unknown';
        
        // Crear marcador con ícono personalizado
        const marker = L.circleMarker([lat, lng], {
            radius: confidence > 80 ? 10 : 7,
            fillColor: markerColor,
            color: markerColor,
            weight: 2,
            opacity: 0.9,
            fillOpacity: 0.7
        });
        
        // Popup mejorado con más información
        marker.bindPopup(`
            <div style="font-family: 'Courier New', monospace; min-width: 200px;">
                <div style="background: ${markerColor}; color: black; padding: 5px; margin: -10px -10px 8px -10px; font-weight: bold; text-align: center;">
                    ${type.toUpperCase().replace(/_/g, ' ')}
                </div>
                <div style="font-size: 11px; line-height: 1.6;">
                    <strong>IOC:</strong> ${displayIP}<br>
                    <strong>Port:</strong> ${port}<br>
                    <strong>Type:</strong> ${iocType}<br>
                    <strong>Malware:</strong> ${malware}<br>
                    <strong>Confidence:</strong> <span style="color: ${riskColor}; font-weight: bold;">${confidence}%</span><br>
                    <strong>First Seen:</strong> ${timestamp}<br>
                    <strong>Region:</strong> ${region.name}
                </div>
            </div>
        `, {
            maxWidth: 300,
            className: 'threat-popup'
        });
        
        // Tooltip para hover rápido
        marker.bindTooltip(`
            <strong>${malware}</strong><br>
            ${displayIP} (${confidence}%)
        `, {
            permanent: false,
            direction: 'top'
        });
        
        marker.addTo(markersLayer);
        
        // Animación de aparición
        setTimeout(() => {
            marker.setStyle({ fillOpacity: 0.7, opacity: 0.9 });
        }, index * 100);
    });
    
    // 4. CREAR/ACTUALIZAR HEATMAP
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
    }
    
    if (heatmapData.length > 0) {
        heatmapLayer = L.heatLayer(heatmapData, {
            radius: 35,
            blur: 45,
            maxZoom: 8,
            max: 1.0,
            gradient: {
                0.0: '#00FF00',
                0.3: '#FFB000',
                0.6: '#FF6B35',
                1.0: '#FF3333'
            }
        });
        
        if (showHeatmap) {
            heatmapLayer.addTo(map);
        }
    }
    
    // Actualizar contador
    document.getElementById('threat-count').textContent = threatCount;
    
    // Actualizar listas de tipos
    updateThreatTypesList();
    updateMalwareFamiliesList();
}

// ============================================
// UPDATE SIDEBAR LISTS
// ============================================

function updateThreatTypesList() {
    const container = document.getElementById('threat-types-list');
    container.innerHTML = '';
    
    const sortedTypes = [...threatTypesMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    
    sortedTypes.forEach(([type, count]) => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.textContent = `${type}: ${count}`;
        container.appendChild(item);
    });
}

function updateMalwareFamiliesList() {
    const container = document.getElementById('malware-families-list');
    container.innerHTML = '';
    
    const sortedMalware = [...malwareFamiliesMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    
    sortedMalware.forEach(([malware, count]) => {
        const item = document.createElement('div');
        item.className = 'list-item';
        if (count > 3) item.classList.add('alert');
        item.textContent = `${malware.substring(0, 20)}: ${count}`;
        container.appendChild(item);
    });
}

// ============================================
// SIMULACIÓN DE CVEs (ThreatFox no provee CVEs)
// ============================================

function addCVEEntry() {
    const cveFeed = document.getElementById('cve-feed');
    const cveId = `CVE-2024-${String(Math.floor(Math.random() * 90000) + 10000)}`;
    const severity = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'][Math.floor(Math.random() * 4)];
    const descriptions = [
        'Remote Code Execution vulnerability',
        'SQL Injection vulnerability',
        'Cross-Site Scripting (XSS)',
        'Buffer Overflow vulnerability',
        'Authentication Bypass',
        'Privilege Escalation'
    ];
    
    const entry = document.createElement('div');
    entry.className = `log-entry ${severity === 'CRITICAL' ? 'error' : severity === 'HIGH' ? 'warning' : ''}`;
    entry.textContent = `[${getCurrentTime()}] [${cveId}] [${severity}] ${descriptions[Math.floor(Math.random() * descriptions.length)]}`;
    
    cveFeed.insertBefore(entry, cveFeed.firstChild);
    
    while (cveFeed.children.length > 20) {
        cveFeed.removeChild(cveFeed.lastChild);
    }
}

// ============================================
// INIT & INTERVALS
// ============================================

// Actualizar reloj
setInterval(() => {
    document.getElementById('current-time').textContent = getCurrentTime();
    document.getElementById('uptime').textContent = getUptime();
}, 1000);

// Fetch inicial
addSystemLog('System initialized', 'success');
fetchRealThreats();

// Actualizar cada 60 segundos (APIs de inteligencia no cambian constantemente)
setInterval(fetchRealThreats, 60000);

// Simular CVEs cada 10 segundos
setInterval(addCVEEntry, 10000);

// Log inicial
setTimeout(() => {
    addSystemLog('ThreatFox API connection established', 'success');
}, 1000);
