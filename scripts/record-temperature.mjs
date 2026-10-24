import fs from 'node:fs/promises';
import path from 'node:path';
import { pointOnFeature } from '@turf/point-on-feature';

// Run from the repository root: npm run record
// The website's current air temperature uses 5-nearest-station IDW (p=2).
const NEA_API = 'https://api-open.data.gov.sg/v2/real-time/api/air-temperature';
const GEOJSON_PATH = 'data/planning-area.geojson';
const ARCHIVE_DIR = 'data/hourly';
const HEADER = 'time_sgt,planning_area,temperature_c,nea_observed_at,active_stations,nearest_used,status';
const HOURS = Math.max(1, Math.min(168, Number.parseInt(process.env.LOOKBACK_HOURS || '48', 10) || 48));
const ONE_HOUR = 3_600_000;
const SGT_OFFSET = 8 * ONE_HOUR;

function sgtHour(utcMillis) {
  return new Date(utcMillis + SGT_OFFSET).toISOString().slice(0, 13) + ':00:00';
}

function sphericalDistance(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2-lat1)*rad/2)**2
      + Math.cos(lat1*rad) * Math.cos(lat2*rad)
      * Math.sin((lon2-lon1)*rad/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1-a)));
}

function idw(lat, lon, stations) {
  const nearest = stations.map(s => ({
    value: s.value,
    distance: sphericalDistance(lat, lon, s.lat, s.lon)
  })).sort((a,b) => a.distance-b.distance).slice(0,5);
  if (nearest.length < 5) return null;
  if (nearest[0].distance < 0.05) return nearest[0].value;
  let total = 0, weightSum = 0;
  for (const s of nearest) {
    const w = 1 / (s.distance ** 2);
    total += s.value * w;
    weightSum += w;
  }
  return total / weightSum;
}

function csvCell(value) {
  const string = String(value ?? '');
  return /[",\r\n]/.test(string) ? '"' + string.replaceAll('"', '""') + '"' : string;
}

function line(values) {
  return values.map(csvCell).join(',');
}

// The generated CSV is simple: unique administrative names, no embedded newlines.
async function readArchive(filename) {
  try {
    const raw = await fs.readFile(filename, 'utf8');
    return raw.trim().split(/\r?\n/).slice(1).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function getJSON(url) {
  let error;
  for (let attempt=1; attempt<=3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error(`NEA HTTP ${res.status}`);
      const body = await res.json();
      if (body.code !== 0 || !body.data) throw new Error(`NEA invalid response: ${body.errorMsg || body.code}`);
      return body.data;
    } catch (e) {
      error = e;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000*attempt));
    }
  }
  throw error;
}

async function fetchHour(hourSGT) {
  const url = new URL(NEA_API);
  url.searchParams.set('date', hourSGT);
  const data = await getJSON(url);
  const readings = data.readings || [];
  const reading = readings.find(x => Array.isArray(x.data));
  if (!reading) throw new Error('No station readings returned');

  const observedUTC = Date.parse(reading.timestamp);
  // Reject stale data. The request is for the latest observation <= the given SGT hour.
  const hourUTC = Date.parse(hourSGT + '+08:00');
  if (!Number.isFinite(observedUTC) || observedUTC > hourUTC + 60_000 || hourUTC-observedUTC > 20*60_000) {
    throw new Error(`NEA observation time too far from hour: ${reading.timestamp}`);
  }

  const values = new Map((reading.data || [])
    .filter(r => Number.isFinite(Number(r.value)))
    .map(r => [r.stationId, Number(r.value)]));
  const stations = (data.stations || []).flatMap(s => {
    const loc = s.location || s.labelLocation;
    const value = values.get(s.id);
    if (!loc || !Number.isFinite(value) ||
        !Number.isFinite(Number(loc.latitude)) || !Number.isFinite(Number(loc.longitude))) return [];
    return [{ lat: Number(loc.latitude), lon: Number(loc.longitude), value }];
  });
  if (stations.length < 5) throw new Error(`Only ${stations.length} active NEA stations`);
  return { stations, observedAt: reading.timestamp };
}

async function main() {
  const geojson = JSON.parse(await fs.readFile(GEOJSON_PATH, 'utf8'));
  if (!Array.isArray(geojson.features) || geojson.features.length === 0) {
    throw new Error('Invalid Planning Area GeoJSON');
  }
  const areas = geojson.features.map(feature => {
    const name = feature.properties?.PLN_AREA_N;
    if (!name) throw new Error('Missing PLN_AREA_N field in GeoJSON');
    const [lon, lat] = pointOnFeature(feature).geometry.coordinates;
    return { name, lat, lon };
  });
  console.log(`Planning areas: ${areas.length}; lookback: ${HOURS} hours`);
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });

  const latestUtcHour = Math.floor(Date.now() / ONE_HOUR) * ONE_HOUR;
  let successfulHours = 0, missingHours = 0, alreadyComplete = 0;
  const months = new Map();

  for (let offset=HOURS-1; offset>=0; offset--) {
    const hour = sgtHour(latestUtcHour - offset*ONE_HOUR);
    const month = hour.slice(0,7);
    const filename = path.join(ARCHIVE_DIR, `${month}.csv`);
    if (!months.has(month)) months.set(month, await readArchive(filename));
    const lines = months.get(month);
    const existing = lines.filter(row => row.startsWith(hour + ','));
    if (existing.length === areas.length && existing.every(row => row.endsWith(',ok'))) {
      alreadyComplete++;
      continue;
    }

    let rows;
    try {
      const weather = await fetchHour(hour);
      rows = areas.map(area => {
        const temp = idw(area.lat, area.lon, weather.stations);
        if (temp === null) throw new Error('IDW unavailable');
        return line([hour,area.name,temp.toFixed(2),weather.observedAt,weather.stations.length,5,'ok']);
      });
      successfulHours++;
      console.log(`${hour}: recorded ${rows.length} areas, NEA stations ${weather.stations.length}`);
    } catch (err) {
      // Keep a complete time grid; missing readings are blank, not invented.
      rows = areas.map(area => line([hour,area.name,'','',0,0,'missing']));
      missingHours++;
      console.warn(`${hour}: missing data (${err.message})`);
    }

    months.set(month, [...lines.filter(row => !row.startsWith(hour + ',')), ...rows]);
  }

  for (const [month, rows] of months) {
    const file = path.join(ARCHIVE_DIR, `${month}.csv`);
    rows.sort(); // YYYY-MM-DDTHH:mm:ss, then Planning Area
    await fs.writeFile(file, HEADER + '\n' + rows.join('\n') + (rows.length ? '\n' : ''), 'utf8');
    console.log(`${file}: ${rows.length} records`);
  }
  console.log(`Hours: ${successfulHours} updated, ${alreadyComplete} complete, ${missingHours} missing`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
