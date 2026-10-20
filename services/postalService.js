const POSTAL_API_BASE_URL = process.env.POSTAL_API_BASE_URL || 'https://api.pincodeapi.in/api/v1';
const postalCache = new Map();

function postalError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePostalResponse(payload, pincode) {
  const offices = Array.isArray(payload?.data?.post_offices) ? payload.data.post_offices : [];
  const first = offices.find((office) => office?.state && office?.district);
  if (!payload?.success || !first) throw postalError('No postal location was found for this PIN code.', 404);
  const postOffices = [...new Set(offices
    .map((office) => String(office?.office_name || '').trim())
    .filter(Boolean))];
  return {
    pincode,
    state: String(first.state).trim(),
    city: postOffices[0] || '',
    district: String(first.district).trim(),
    post_offices: postOffices,
  };
}

function postalRecords(payload) {
  const data = payload?.data;
  const candidates = [data?.post_offices, data?.results, data?.records, Array.isArray(data) ? data : null];
  return candidates.find(Array.isArray) || [];
}

async function fetchPostalDirectory(path, cacheKey) {
  if (postalCache.has(cacheKey)) return postalCache.get(cacheKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${POSTAL_API_BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 404) throw postalError('No postal locations were found.', 404);
    if (response.status === 429) throw postalError('Postal lookup is busy. Please wait a moment and try again.', 503);
    if (!response.ok) throw postalError('Postal directory is temporarily unavailable.');
    const payload = await response.json();
    if (!payload?.success) throw postalError('No postal locations were found.', 404);
    postalCache.set(cacheKey, payload);
    return payload;
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.name === 'AbortError') throw postalError('Postal lookup timed out.', 504);
    throw postalError('Postal directory is temporarily unavailable.');
  } finally {
    clearTimeout(timeout);
  }
}

async function listDistrictsForState(value) {
  const state = String(value || '').trim();
  if (!state || state.length > 100) throw postalError('Select a valid state.', 400);
  const payload = await fetchPostalDirectory(`/state/${encodeURIComponent(state)}`, `state:${state.toLowerCase()}`);
  const suppliedDistricts = Array.isArray(payload?.data?.districts) ? payload.data.districts : [];
  const districts = suppliedDistricts.length
    ? suppliedDistricts.map((item) => String(item?.name || item?.district || item || '').trim())
    : postalRecords(payload)
      .filter((record) => !record?.state || String(record.state).trim().toLowerCase() === state.toLowerCase())
      .map((record) => String(record?.district || '').trim());
  return { country: 'India', state, districts: [...new Set(districts.filter(Boolean))].sort((left, right) => left.localeCompare(right)) };
}

async function listCitiesForDistrict(stateValue, districtValue) {
  const state = String(stateValue || '').trim();
  const district = String(districtValue || '').trim();
  if (!state || state.length > 100 || !district || district.length > 100) throw postalError('Select a valid state and district.', 400);
  const payload = await fetchPostalDirectory(`/district/${encodeURIComponent(district)}`, `district:${state.toLowerCase()}:${district.toLowerCase()}`);
  const suppliedCities = Array.isArray(payload?.data?.cities) ? payload.data.cities : [];
  const cities = suppliedCities.length
    ? suppliedCities.map((item) => String(item?.name || item?.office_name || item || '').trim())
    : postalRecords(payload)
      .filter((record) => (!record?.state || String(record.state).trim().toLowerCase() === state.toLowerCase())
        && (!record?.district || String(record.district).trim().toLowerCase() === district.toLowerCase()))
      .map((record) => String(record?.office_name || record?.city || '').trim());
  return { country: 'India', state, district, cities: [...new Set(cities.filter(Boolean))].sort((left, right) => left.localeCompare(right)) };
}

async function lookupPincode(value) {
  const pincode = String(value || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(pincode)) throw postalError('PIN code must be exactly 6 digits.', 400);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${POSTAL_API_BASE_URL}/pincode/${pincode}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 404) throw postalError('No postal location was found for this PIN code.', 404);
    if (response.status === 429) throw postalError('Postal lookup is busy. Please wait a moment and try again.', 503);
    if (!response.ok) throw postalError('Postal lookup is temporarily unavailable. Enter the location manually.');
    return normalizePostalResponse(await response.json(), pincode);
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.name === 'AbortError') throw postalError('Postal lookup timed out. Enter the location manually.', 504);
    throw postalError('Postal lookup is temporarily unavailable. Enter the location manually.');
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { lookupPincode, normalizePostalResponse, listDistrictsForState, listCitiesForDistrict };
