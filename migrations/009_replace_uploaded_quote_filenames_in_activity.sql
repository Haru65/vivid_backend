UPDATE lead_activities AS activity
SET content = REPLACE(activity.content, upload.filename, upload.quotation_number)
FROM estimation_requests AS request
JOIN estimation_quote_uploads AS upload
  ON upload.estimation_request_id = request.id
WHERE activity.lead_id = request.lead_id
  AND activity.activity_type = 'system'
  AND upload.quotation_number IS NOT NULL
  AND POSITION(upload.filename IN activity.content) > 0;
