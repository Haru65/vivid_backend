const POSTAL_API_BASE_URL = process.env.POSTAL_API_BASE_URL || 'https://api.pincodeapi.in/api/v1';

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

module.exports = { lookupPincode, normalizePostalResponse };
