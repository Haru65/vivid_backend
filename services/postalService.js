const { getIndiaPincode } = require('india-pincode');

const POSTAL_API_BASE_URL = process.env.POSTAL_API_BASE_URL || 'https://api.pincodeapi.in/api/v1';
let localPostalDirectory;

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

function postalDirectory() {
  if (!localPostalDirectory) localPostalDirectory = getIndiaPincode();
  return localPostalDirectory;
}

function formatPostalName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function directoryStateName(value) {
  const state = String(value || '').trim().toUpperCase();
  return state === 'DADRA AND NAGAR HAVELI AND DAMAN AND DIU'
    ? 'THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU'
    : state;
}

async function listDistrictsForState(value) {
  const state = String(value || '').trim();
  if (!state || state.length > 100) throw postalError('Select a valid state.', 400);
  const result = postalDirectory().getDistrictsByState(directoryStateName(state));
  if (!result?.success || !Array.isArray(result.data) || !result.data.length) {
    throw postalError('No districts were found for this state.', 404);
  }
  const districts = result.data.map(formatPostalName).sort((left, right) => left.localeCompare(right));
  return { country: 'India', state, districts };
}

async function listCitiesForDistrict(stateValue, districtValue) {
  const state = String(stateValue || '').trim();
  const district = String(districtValue || '').trim();
  if (!state || state.length > 100 || !district || district.length > 100) throw postalError('Select a valid state and district.', 400);
  const result = postalDirectory().getByDistrict(district, { limit: 100000 });
  if (!result?.success || !Array.isArray(result.data?.data)) {
    throw postalError('No cities or towns were found for this district.', 404);
  }
  const normalizedState = directoryStateName(state);
  const cityPincodeSets = new Map();
  result.data.data
    .filter((record) => String(record?.state || '').toUpperCase() === normalizedState)
    .forEach((record) => {
      const city = String(record?.area || '').replace(/\s+(?:B|S|H|G)\.?\s*O\.?(?=\s*(?:\(|$))/gi, '').trim();
      const pincode = String(record?.pincode || '').replace(/\D/g, '');
      if (!city) return;
      if (!cityPincodeSets.has(city)) cityPincodeSets.set(city, new Set());
      if (pincode.length === 6) cityPincodeSets.get(city).add(pincode);
    });
  const cities = [...cityPincodeSets.keys()].sort((left, right) => left.localeCompare(right));
  if (!cities.length) throw postalError('No cities or towns were found for this district.', 404);
  const city_pincodes = Object.fromEntries(cities.map((city) => [city, [...cityPincodeSets.get(city)].sort()]));
  return { country: 'India', state, district, cities, city_pincodes };
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
