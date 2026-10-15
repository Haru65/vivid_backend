const {PDFDocument,StandardFonts,rgb,} = require("pdf-lib");
const fs = require("fs");
const path = require ("path");

async function generateQuotationPdf(data = {}, user, options = {}) {
  const pdfDoc = await PDFDocument.create();
  const quotationData = data || {};

  // A4 in points
  const pageWidth = 595.28;
  const pageHeight = 841.89;

  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  // ----------------------------------------------------
  // 1. LOAD YOUR QUOTATION FORMAT AS BACKGROUND IMAGE
  // ----------------------------------------------------

  const templateBytes = fs.readFileSync(path.join(__dirname, "../public/base_image.png"));

  const templateImage = await pdfDoc.embedPng(templateBytes);

  page.drawImage(templateImage, {
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight,
  });

  // ----------------------------------------------------
  // 2. FONTS
  // ----------------------------------------------------

  const regularFont = await pdfDoc.embedFont(
    StandardFonts.Helvetica
  );

  const boldFont = await pdfDoc.embedFont(
    StandardFonts.HelveticaBold
  );

  const italicFont = await pdfDoc.embedFont(
    StandardFonts.HelveticaOblique
  );

  const boldItalicFont = await pdfDoc.embedFont(
    StandardFonts.HelveticaBoldOblique
  );

  // ----------------------------------------------------
  // 3. QUOTATION DATA
  // ----------------------------------------------------

  const quotation = {
    reference: quotationData.quotationNumber || quotationData.quotation_number || "N/A",

    date: new Date(quotationData.created_at || quotationData.sent_at || Date.now()).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        }),

    customerName: quotationData.customerName || quotationData.company_name || quotationData.billing_name || "Customer",

    subject:
      quotationData.subject || "Supply of Electrical Panels and Accessories",

    recipient: quotationData.contact_person_name ? quotationData.contact_person_name : "Sir/Madam",

    salesperson: quotationData.assigned_to || quotationData.salesperson || user?.name || "Vivid Electromech",
  };

  // ----------------------------------------------------
  // 4. DRAW DYNAMIC DATA
  // ----------------------------------------------------

  // Reference
  page.drawText(`OUR REF: ${quotation.reference}`, {
    x: 48,
    y: 694,
    size: 11,
    font: regularFont,
    color: rgb(0, 0, 0),
  });

  // Date
  page.drawText(`Date: ${quotation.date}`, {
    x: 477,
    y: 694,
    size: 11,
    font: regularFont,
    color: rgb(0, 0, 0),
  });

  // "To,"
  page.drawText("To,", {
    x: 48,
    y: 660,
    size: 12,
    font: regularFont,
  });

  // Customer
  page.drawText(quotation.customerName, {
    x: 48,
    y: 630,
    size: 13,
    font: boldFont,
  });

  // Subject label
  page.drawText("Subject:", {
    x: 160,
    y: 565,
    size: 12,
    font: regularFont,
  });

  // Subject
  page.drawText(`- ${quotation.subject}`, {
    x: 210,
    y: 565,
    size: 12,
    font: regularFont,
  });

  // Dear
  page.drawText(`Dear ${quotation.recipient},`, {
    x: 48,
    y: 532,
    size: 12,
    font: regularFont,
  });

  // Intro paragraph
  drawWrappedText(
    page,
    `We are in receipt of your above enquiry and thank you for your kind courtesy and consideration extended for participation in your esteem project. As per your requirement we are pleased to submit our offer for the subject item for your kind perusal.`,
    {
      x: 48,
      y: 500,
      maxWidth: 500,
      size: 12,
      lineHeight: 17,
      font: regularFont,
    }
  );

  // Brief introduction heading
  const heading = "OUR BRIEF INTRODUCTION";

  const headingWidth = boldFont.widthOfTextAtSize(
    heading,
    12
  );

  page.drawText(heading, {
    x: (pageWidth - headingWidth) / 2,
    y: 435,
    size: 12,
    font: boldFont,
  });

  // Introduction paragraph
  drawWrappedText(
    page,
    `We Vivid Electromech Ltd are in manufacturing of LV & HT Panels from past two decades & we are manufacturer of all type of LT panels as per IEC 60439, IEC 61439, IEC 61641.`,
    {
      x: 48,
      y: 410,
      maxWidth: 500,
      size: 12,
      lineHeight: 17,
      font: regularFont,
    }
  );

  // Annexures
  page.drawText("Annexure # I Price Schedule.", {
    x: 48,
    y: 350,
    size: 12,
    font: regularFont,
  });

  page.drawText("Annexure # II Technical Notes.", {
    x: 48,
    y: 335,
    size: 12,
    font: regularFont,
  });

  page.drawText("Annexure # III Commercial Terms & Conditions.", {
    x: 48,
    y: 320,
    size: 12,
    font: regularFont,
  });

  

  // Closing
  page.drawText(
    "Hope our offer is in line with your requirement and please feels free if you have any further clarification.",
    {
      x: 54,
      y: 255,
      size: 11,
      font: regularFont,
    }
  );

  page.drawText("Thanking you.", {
    x: 48,
    y: 220,
    size: 12,
    font: regularFont,
  });

  page.drawText("Yours faithfully.", {
    x: 48,
    y: 205,
    size: 12,
    font: regularFont,
  });

  page.drawText(quotation.salesperson, {
    x: 48,
    y: 190,
    size: 12,
    font: regularFont,
  });

  drawPriceSchedulePages(pdfDoc, templateImage, quotationData, quotation, {
    pageWidth,
    pageHeight,
    regularFont,
    boldFont,
    italicFont,
    boldItalicFont,
  });

  drawTechnicalNotesPages(pdfDoc, templateImage, quotationData, quotation, {
    pageWidth,
    pageHeight,
    regularFont,
    boldFont,
    italicFont,
    boldItalicFont,
  });

  drawCommercialTermsAnnexurePages(pdfDoc, quotationData, quotation, {
    pageWidth,
    pageHeight,
    regularFont,
    boldFont,
    italicFont,
    boldItalicFont,
  });

  // ----------------------------------------------------
  // 5. SAVE PDF
  // ----------------------------------------------------

  const pdfBytes = Buffer.from(await pdfDoc.save());

  if (options.outputPath) {
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, pdfBytes);
    console.log(`Quotation PDF created: ${options.outputPath}`);
  }

  return pdfBytes;
}

function drawTechnicalNotesPages(pdfDoc, templateImage, quotationData, quotation, layout) {
  const rows = buildTechnicalReferenceRows(quotationData.technical_notes_data);
  const columns = [
    { label: 'Sr.No.', x: 30, width: 40 },
    { label: 'RFQ DOCUMENT', x: 70, width: 105 },
    { label: 'Specification/SLD/BOM requirement', x: 175, width: 190 },
    { label: "Consideration For M'SET Design", x: 365, width: 200 },
  ];
  let page = createTechnicalNotesPage(pdfDoc, templateImage, quotationData, quotation, layout, columns, false);
  let cursorY = 602;

  rows.forEach((row) => {
    const rfqLines = wrapText(row.rfqDocument, layout.regularFont, 9, columns[1].width - 10);
    const requirementLines = wrapText(row.requirement, layout.regularFont, 9, columns[2].width - 10);
    const considerationLines = wrapText(row.consideration, layout.regularFont, 9, columns[3].width - 10);
    const rowHeight = Math.max(34, 14 + Math.max(rfqLines.length, requirementLines.length, considerationLines.length) * 11);
    if (cursorY - rowHeight < 175) {
      page = createTechnicalNotesPage(pdfDoc, templateImage, quotationData, quotation, layout, columns, true);
      cursorY = 602;
    }
    drawTableGrid(page, columns, cursorY, rowHeight);
    drawCellText(page, String(row.sr), columns[0].x, cursorY - rowHeight / 2 - 4, columns[0].width, 9, layout.regularFont, 'center');
    drawMultilineCell(page, rfqLines, columns[1].x, cursorY - 17, columns[1].width, 9, layout.regularFont, 'center');
    drawMultilineCell(page, requirementLines, columns[2].x, cursorY - 17, columns[2].width, 9, layout.regularFont, 'center');
    drawMultilineCell(page, considerationLines, columns[3].x, cursorY - 17, columns[3].width, 9, layout.regularFont, 'left');
    cursorY -= rowHeight;
  });
}

function createTechnicalNotesPage(pdfDoc, templateImage, quotationData, quotation, layout, columns, continued) {
  const page = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);
  page.drawImage(templateImage, { x: 0, y: 0, width: layout.pageWidth, height: layout.pageHeight });
  const title = buildPriceScheduleTitle(quotationData, quotation);
  drawCenteredText(page, title, 660, fitTextSize(title, layout.boldFont, 13, 10, 500), layout.boldFont, layout.pageWidth);
  drawCenteredText(page, continued ? 'Annexure-II (Continued)' : 'Annexure-II', 640, 13, layout.boldFont, layout.pageWidth);
  const headerY = 632;
  drawTableGrid(page, columns, headerY, 30);
  columns.forEach((column) => drawMultilineCell(page, wrapText(column.label, layout.boldFont, 7.5, column.width - 6), column.x, headerY - 11, column.width, 7.5, layout.boldFont, 'center'));
  return page;
}

function normalizeTechnicalNotes(items) {
  if (typeof items === 'string') {
    try {
      return normalizeTechnicalNotes(JSON.parse(items));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => ({
    code: String(item.code || ''),
    section: String(item.section || 'General'),
    label: String(item.pdf_label || item.label || item.code || `Technical note ${index + 1}`),
    value: String(item.value || ''),
    display_order: Number(item.display_order || (index + 1) * 10),
  })).sort((left, right) => left.display_order - right.display_order);
}

function buildTechnicalReferenceRows(items) {
  const values = new Map(normalizeTechnicalNotes(items).map((item) => [String(item.code || '').toUpperCase(), item.value]));
  const value = (code, fallback = 'Not specified') => String(values.get(code) || fallback);
  const installation = value('INSTALLATION');
  const ipRating = value('IP_RATING');
  const paint = value('PAINT');
  const busbar = value('BUSBAR');
  const meter = value('METER');
  const relay = value('RELAY');
  return [
    { sr: 1, rfqDocument: 'BOQ', requirement: 'Degree of Protection', consideration: `We have considered panel ${installation} type with ${ipRating}.` },
    { sr: 2, rfqDocument: 'Consideration', requirement: 'Paint Shade.', consideration: `The Panel will be powder coated with ${paint}.` },
    { sr: 3, rfqDocument: 'BOQ', requirement: 'Busbar', consideration: `Bus bar will be ${busbar}.` },
    { sr: 4, rfqDocument: 'BOQ', requirement: 'Meter', consideration: `We have considered ${meter} as per BOQ.` },
    { sr: 5, rfqDocument: 'BOQ', requirement: 'Relay', consideration: `We have considered ${relay} as per BOQ.` },
  ];
}

function drawCommercialTermsAnnexurePages(pdfDoc, quotationData, quotation, layout) {
  const firstPageTerms = [
    ['Price', 'As per Price Schedule (Annexure #1), price are ex-works. Price not valid for partial order and/or reduction in quantity.'],
    ['Scope', 'Our scope is limited to supply only. Unloading, Installation, Shifting, Commissioning etc. are not included in our scope.'],
    ['Payment', '10% advance along with PO\n30% after drawing approval\n60% after successfully Inspection at our works before dispatch.'],
    ['Jurisdiction', 'The Laws of Indian Union in Force shall govern this order. Only the Competent courts in Navi Mumbai shall have the jurisdiction.'],
    ['GST & HSN Code', 'LT Panel  -  HSN 85371000\nHT Panel  -  HSN 85372000\nRMU       -  HSN 85372000\nBus Duct  -  HSN 85371000\n18% Extra or as applicable at the time of dispatch'],
    ['Performance Bank Guarantee (PBG)', 'On special request we will provide PBG at extra cost for the duration of the defect liability period. The duration of the PBG will include statutory claim period of 1 year as per RBI guidelines.'],
    ['Tax Collected at Source', 'a.) We will collect TCS @ 0.1% through our sales invoices, if the value of sale consideration or aggregate of sale consideration from VIVID ELECTROMECH LTD. to you exceeds Rs. 50 Lakh in current year same to reflect on your Purchase order.\nNecessary TCS certificate will be issued by us as per the provisions of the Income Tax Act 1961\nb.) Budget 2021 Update: In case of transaction on which TDS u/s. 194Q is applicable w.e.f 01/07/2021, then TCS u/s. 206C (1H) will Not be applicable'],
    ['Freight', "In customer's scope or Extra At Actual."],
    ['Insurance', "In customer's scope or Extra At Actual."],
    ['Packing', 'Panels will be packed in 2 ply corrugated sheet with additional plastic sheet wrapping. Any other type of packing if required will be provided at extra cost.'],
    ['Validity of offer', '15 days from the date of quotation and on confirmation thereafter.'],
    ['Delivery period', 'Inspection call will be raised 7 to 9 weeks from the date of advance and or manufacturing clearance in writing whichever is later.'],
  ];
  const secondPageTerms = [
    ['Delay in Dispatch Clearance', 'Post Manufacturing Clearance, and Post above mentioned Delivery Period, if there is any delay from Client Site for Dispatch clearance, we shall charge Liquidated Damages of 0.5% per week and any mutually agreed payment terms viz LC, PDC, Etc. will be null and void and 100% Balance Payment along with said LD to be Made Prior to dispatch.'],
    ['Delay in delivery', 'Unforeseen events beyond our control such as force major, strikes, lockouts, breakdown delay in supply of essential raw materials, whether occurring in our or those of the sub-contractors works, changes in BOQ/technical specs after drawing approval, delay in approval of drawings will extend the committed delivery period for such a time as covered by such events as long as such events will have material bearing on the fulfillment of the contracts or the part thereof, which will become due.'],
    ['Warrantee', 'The equipment is manufactured in accordance to IEC specifications. We give Warranty of 12 months from date of manufacturing. Subjected to the 100% payment clearance. We are not liable for defects of parts in due to inadequate maintenance, bad handling from long and improper storage. Any other defects of parts will be repaired /replaced (delivery ex-works) at our discretion free of cost to you provided you furnish sufficient proof to our satisfaction that the defects are entirely due to defective design and/or manufacturer /workmanship. All incidental charges for the production of such events proof will be borne by you.'],
    ['Loading', 'In our scope.'],
    ['Unloading at site', 'Unloading at site is not in our scope.'],
    ['Commissioning', 'Scope of order includes supply of panels only. Commissioning assistance after installation on chargeable basis. Switchboard unloading, positioning, installation, cable joining will not be in our scope.'],
    ['Inspection', 'At our workshop before delivery. Will be intimated by us before delivery of panels.'],
    ['Ownership of Goods', 'The ownership of goods will be transferred to your name only after the receipt of entire payment for you.'],
  ];
  drawCommercialTermsPage(pdfDoc, quotationData, quotation, layout, firstPageTerms, false, false);
  drawCommercialTermsPage(pdfDoc, quotationData, quotation, layout, secondPageTerms, true, true);
}

function drawCommercialTermsPage(pdfDoc, quotationData, quotation, layout, terms, continued, closing) {
  const page = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);
  const title = buildPriceScheduleTitle(quotationData, quotation);
  drawCenteredText(page, title, 785, fitTextSize(title, layout.boldItalicFont, 12, 9, 500), layout.boldItalicFont, layout.pageWidth);
  if (!continued) drawCenteredText(page, 'ANNEXURE-III', 765, 11, layout.boldItalicFont, layout.pageWidth);
  let y = continued ? 748 : 735;
  const columns = [
    { x: 30, width: 105 },
    { x: 135, width: 24 },
    { x: 159, width: 406 },
  ];
  terms.forEach(([label, content]) => {
    const labelLines = wrapText(label, layout.boldItalicFont, 9, columns[0].width - 8);
    const contentLines = wrapTextWithBreaks(content, layout.italicFont, 9, columns[2].width - 10);
    const height = Math.max(28, 12 + Math.max(labelLines.length, contentLines.length) * 11);
    drawTableGrid(page, columns, y, height);
    drawMultilineCell(page, labelLines, columns[0].x, y - 16, columns[0].width, 9, layout.boldItalicFont, 'left');
    drawCellText(page, ':', columns[1].x, y - height / 2 - 3, columns[1].width, 9, layout.italicFont, 'center');
    drawMultilineCell(page, contentLines, columns[2].x, y - 16, columns[2].width, 9, layout.italicFont, 'left');
    y -= height;
  });
  if (closing) {
    page.drawText('Hope our offers are in line with your requirement and please feel free if you have any further clarification.', {
      x: 32,
      y: Math.max(55, y - 28),
      size: 9,
      font: layout.italicFont,
      color: rgb(0, 0, 0),
    });
  }
}

function wrapTextWithBreaks(text, font, size, maxWidth) {
  return String(text || '').split('\n').flatMap((paragraph, index, paragraphs) => {
    const lines = wrapText(paragraph, font, size, maxWidth);
    return index < paragraphs.length - 1 ? [...lines, ''] : lines;
  });
}

function drawPriceSchedulePages(pdfDoc, templateImage, quotationData, quotation, layout) {
  const lineItems = normalizePriceItems(quotationData.line_items);
  const rows = lineItems.length ? lineItems : [{ description: "No line items added", quantity: 0, unit_price: 0, amount: 0 }];
  const totalQuantity = rows.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const calculatedSubtotal = rows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const subtotal = Number(quotationData.subtotal ?? calculatedSubtotal);
  const discountAmount = Number(quotationData.discount_amount || 0);
  const gstAmount = Number(quotationData.gst_amount || 0);
  const totalAmount = Number(quotationData.final_price ?? quotationData.total_amount ?? (subtotal - discountAmount + gstAmount));
  const columns = [
    { key: "sr", label: "Sr.no.", x: 30, width: 40, align: "center" },
    { key: "item", label: "Item", x: 70, width: 265, align: "center" },
    { key: "quantity", label: "Qty.", x: 335, width: 40, align: "center" },
    { key: "unit", label: "Unit", x: 375, width: 45, align: "center" },
    { key: "rate", label: "Rate", x: 420, width: 70, align: "right" },
    { key: "amount", label: "Amount", x: 490, width: 75, align: "right" },
  ];

  let page = createAnnexurePage(pdfDoc, templateImage, quotationData, quotation, layout, false);
  let cursorY = 612;
  let currentPageRows = [];
  const minY = 260;

  rows.forEach((item, index) => {
    const descriptionLines = wrapText(item.description, layout.regularFont, 10.5, columns[1].width - 12);
    const rowHeight = Math.max(38, 22 + descriptionLines.length * 12);

    if (cursorY - rowHeight < minY && currentPageRows.length) {
      drawContinuationFooter(page, cursorY, layout);
      page = createAnnexurePage(pdfDoc, templateImage, quotationData, quotation, layout, true);
      cursorY = 612;
      currentPageRows = [];
    }

    drawPriceRow(page, columns, cursorY, rowHeight, {
      sr: index + 1,
      descriptionLines,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unit_price,
      amount: item.amount,
    }, layout);
    currentPageRows.push(item);
    cursorY -= rowHeight;
  });

  const summaryY = drawCommercialSummary(page, columns, cursorY, {
    totalQuantity,
    subtotal,
    discountAmount,
    gstAmount,
    gstRate: Number(quotationData.gst_rate || 0),
    totalAmount,
  }, layout);
  drawCommercialTerms(page, quotationData, layout, summaryY - 12);
  drawSignature(page, quotation, layout, summaryY - 76);
}

function createAnnexurePage(pdfDoc, templateImage, quotationData, quotation, layout, continued) {
  const page = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);
  page.drawImage(templateImage, {
    x: 0,
    y: 0,
    width: layout.pageWidth,
    height: layout.pageHeight,
  });

  const title = buildPriceScheduleTitle(quotationData, quotation);
  const titleSize = fitTextSize(title, layout.boldFont, 13, 10, 500);
  const annexureTitle = continued ? "Annexure-I (Continued)" : "Annexure-I";
  drawCenteredText(page, title, 660, titleSize, layout.boldFont, layout.pageWidth);
  drawCenteredText(page, annexureTitle, 640, 13, layout.boldFont, layout.pageWidth);
  page.drawLine({
    start: { x: (layout.pageWidth - layout.boldFont.widthOfTextAtSize(title, titleSize)) / 2, y: 657 },
    end: { x: (layout.pageWidth + layout.boldFont.widthOfTextAtSize(title, titleSize)) / 2, y: 657 },
    thickness: 0.7,
    color: rgb(0, 0, 0),
  });
  page.drawLine({
    start: { x: (layout.pageWidth - layout.boldFont.widthOfTextAtSize(annexureTitle, 13)) / 2, y: 637 },
    end: { x: (layout.pageWidth + layout.boldFont.widthOfTextAtSize(annexureTitle, 13)) / 2, y: 637 },
    thickness: 0.7,
    color: rgb(0, 0, 0),
  });

  drawTableHeader(page, layout);
  return page;
}

function drawTableHeader(page, layout) {
  const columns = [
    { label: "Sr.no.", x: 30, width: 40 },
    { label: "Item", x: 70, width: 265 },
    { label: "Qty.", x: 335, width: 40 },
    { label: "Unit", x: 375, width: 45 },
    { label: "Rate", x: 420, width: 70 },
    { label: "Amount", x: 490, width: 75 },
  ];
  const y = 632;
  const height = 20;
  drawTableGrid(page, columns, y, height);
  columns.forEach((column) => {
    drawCellText(page, column.label, column.x, y - 14, column.width, 10, layout.boldFont, "center");
  });
}

function drawPriceRow(page, columns, y, height, row, layout) {
  drawTableGrid(page, columns, y, height);
  drawCellText(page, String(row.sr), columns[0].x, y - height / 2 - 4, columns[0].width, 10.5, layout.regularFont, "center");
  drawMultilineCell(page, row.descriptionLines, columns[1].x, y - 16, columns[1].width, 10.5, layout.regularFont, "center");
  drawCellText(page, String(row.quantity), columns[2].x, y - height / 2 - 4, columns[2].width, 10.5, layout.regularFont, "center");
  drawCellText(page, String(row.unit || 'No.'), columns[3].x, y - height / 2 - 4, columns[3].width, 10, layout.regularFont, "center");
  drawCellText(page, formatIndianNumber(row.unitPrice), columns[4].x, y - height / 2 - 4, columns[4].width - 5, 10.5, layout.regularFont, "right");
  drawCellText(page, formatIndianNumber(row.amount), columns[5].x, y - height / 2 - 4, columns[5].width - 5, 10.5, layout.regularFont, "right");
}

function drawSummaryRow(page, columns, y, label, value, layout, { quantity = '', bold = false } = {}) {
  const height = 18;
  drawSummaryGrid(page, columns, y, height);
  const font = bold ? layout.boldFont : layout.regularFont;
  const labelX = columns[3].x;
  const labelWidth = columns[3].width + columns[4].width;
  const labelSize = fitTextSize(String(label), font, 10, 8.5, labelWidth - 10);
  drawCellText(page, quantity, columns[2].x, y - 13, columns[2].width, 10.5, font, "center");
  drawCellText(page, label, labelX, y - 13, labelWidth, labelSize, font, "center");
  drawCellText(page, formatIndianNumber(value), columns[5].x, y - 13, columns[5].width - 5, 10.5, font, "right");
  return y - height;
}

function drawSummaryGrid(page, columns, y, height) {
  const tableX = columns[0].x;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  page.drawRectangle({
    x: tableX,
    y: y - height,
    width: tableWidth,
    height,
    borderWidth: 0.7,
    borderColor: rgb(0, 0, 0),
  });
  [columns[1].x, columns[2].x, columns[3].x, columns[5].x].forEach((x) => {
    page.drawLine({
      start: { x, y },
      end: { x, y: y - height },
      thickness: 0.7,
      color: rgb(0, 0, 0),
    });
  });
}

function drawCommercialSummary(page, columns, y, totals, layout) {
  let nextY = drawSummaryRow(page, columns, y, 'SUBTOTAL', totals.subtotal, layout, {
    quantity: formatQuantity(totals.totalQuantity),
  });
  if (totals.discountAmount > 0) {
    nextY = drawSummaryRow(page, columns, nextY, 'DISCOUNT', -totals.discountAmount, layout);
  }
  if (totals.gstAmount > 0 || totals.gstRate > 0) {
    nextY = drawSummaryRow(page, columns, nextY, `GST ${formatQuantity(totals.gstRate)}%`, totals.gstAmount, layout);
  }
  return drawSummaryRow(page, columns, nextY, 'GRAND TOTAL', totals.totalAmount, layout, { bold: true });
}

function drawContinuationFooter(page, y, layout) {
  page.drawText('Continued on next page...', {
    x: 390,
    y: y - 18,
    size: 10,
    font: layout.regularFont,
    color: rgb(0, 0, 0),
  });
}

function drawCommercialTerms(page, quotationData, layout, y) {
  const terms = [
    quotationData.payment_terms ? `Payment: ${quotationData.payment_terms}` : null,
    quotationData.delivery_days !== null && quotationData.delivery_days !== undefined
      ? `Delivery: ${quotationData.delivery_days} days`
      : null,
    quotationData.warranty_terms ? `Warranty: ${quotationData.warranty_terms}` : null,
    quotationData.valid_until ? `Offer valid until: ${new Date(quotationData.valid_until).toLocaleDateString('en-GB')}` : null,
  ].filter(Boolean);
  terms.slice(0, 4).forEach((term, index) => {
    page.drawText(term.slice(0, 95), {
      x: 36,
      y: y - index * 14,
      size: 9,
      font: layout.regularFont,
      color: rgb(0, 0, 0),
    });
  });
}

function drawTableGrid(page, columns, y, height) {
  const tableX = columns[0].x;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  page.drawRectangle({
    x: tableX,
    y: y - height,
    width: tableWidth,
    height,
    borderWidth: 0.7,
    borderColor: rgb(0, 0, 0),
  });
  columns.slice(1).forEach((column) => {
    page.drawLine({
      start: { x: column.x, y },
      end: { x: column.x, y: y - height },
      thickness: 0.7,
      color: rgb(0, 0, 0),
    });
  });
}

function drawSignature(page, quotation, layout, y) {
  const signatureY = Math.max(145, y);
  page.drawText("For Vivid Electromech Ltd.", {
    x: 72,
    y: signatureY,
    size: 11,
    font: layout.regularFont,
    color: rgb(0, 0, 0),
  });
  page.drawText(quotation.salesperson, {
    x: 72,
    y: signatureY - 28,
    size: 11,
    font: layout.regularFont,
    color: rgb(0, 0, 0),
  });
}

function drawCenteredText(page, text, y, size, font, pageWidth) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: (pageWidth - width) / 2,
    y,
    size,
    font,
    color: rgb(0, 0, 0),
  });
}

function drawCellText(page, text, x, y, width, size, font, align = "left") {
  const value = String(text || "");
  const textWidth = font.widthOfTextAtSize(value, size);
  const textX = align === "right"
    ? x + width - textWidth
    : align === "center"
      ? x + (width - textWidth) / 2
      : x + 5;
  page.drawText(value, {
    x: Math.max(x + 3, textX),
    y,
    size,
    font,
    color: rgb(0, 0, 0),
  });
}

function drawMultilineCell(page, lines, x, y, width, size, font, align = "left") {
  lines.forEach((line, index) => {
    drawCellText(page, line, x, y - index * 12, width, size, font, align);
  });
}

function normalizePriceItems(items) {
  if (typeof items === "string") {
    try {
      return normalizePriceItems(JSON.parse(items));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unit_price || item.unitPrice || 0);
    const amount = Number(item.amount || quantity * unitPrice || 0);
    return {
      description: String(item.description || item.item || "").trim() || "Item",
      quantity,
      unit: String(item.unit || 'No.'),
      unit_price: unitPrice,
      amount,
    };
  });
}

function buildPriceScheduleTitle(quotationData, quotation) {
  const reference = quotation.reference || quotationData.quotation_number || quotationData.quotationNumber || "QTN";
  const referenceText = String(reference).replace(/^QT-?/i, "NO-");
  const project = quotationData.project_name || quotationData.company_name || quotation.customerName || "PROJECT";
  return `QTN ${referenceText}-${project}`.toUpperCase();
}

function fitTextSize(text, font, preferredSize, minSize, maxWidth) {
  let size = preferredSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }
  return size;
}

function wrapText(text, font, size, maxWidth) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      return;
    }

    if (line) lines.push(line);
    line = word;
  });

  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function formatIndianNumber(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: Number.isInteger(number) ? 0 : 2,
  }).format(number);
}

function formatQuantity(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function drawWrappedText(
  page,
  text,
  {
    x,
    y,
    maxWidth,
    size,
    lineHeight,
    font,
  }
) {
  const words = text.split(" ");

  let line = "";
  let currentY = y;

  for (const word of words) {
    const testLine =
      line.length === 0
        ? word
        : `${line} ${word}`;

    const width =
      font.widthOfTextAtSize(
        testLine,
        size
      );

    if (width > maxWidth) {
      page.drawText(line, {
        x,
        y: currentY,
        size,
        font,
        color: rgb(0, 0, 0),
      });

      line = word;
      currentY -= lineHeight;
    } else {
      line = testLine;
    }
  }

  if (line) {
    page.drawText(line, {
      x,
      y: currentY,
      size,
      font,
      color: rgb(0, 0, 0),
    });
  }
}

module.exports = {
  generateQuotationPdf,
};
