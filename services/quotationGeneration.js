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

  // ----------------------------------------------------
  // 3. QUOTATION DATA
  // ----------------------------------------------------

  const quotation = {
    reference: quotationData.quotationNumber || quotationData.quotation_number || "N/A",

    date: new Date().toLocaleDateString("en-GB", {
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

function drawPriceSchedulePages(pdfDoc, templateImage, quotationData, quotation, layout) {
  const lineItems = normalizePriceItems(quotationData.line_items);
  const rows = lineItems.length ? lineItems : [{ description: "No line items added", quantity: 0, unit_price: 0, amount: 0 }];
  const totalQuantity = rows.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const totalAmount = rows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const columns = [
    { key: "sr", label: "Sr.no.", x: 30, width: 42, align: "center" },
    { key: "item", label: "Item", x: 72, width: 335, align: "center" },
    { key: "quantity", label: "Qty.", x: 407, width: 30, align: "center" },
    { key: "unit", label: "Unit", x: 437, width: 54, align: "right" },
    { key: "amount", label: "Amount.", x: 491, width: 74, align: "right" },
  ];

  let page = createAnnexurePage(pdfDoc, templateImage, quotationData, quotation, layout, false);
  let cursorY = 612;
  let currentPageRows = [];
  const minY = 190;

  rows.forEach((item, index) => {
    const descriptionLines = wrapText(item.description, layout.regularFont, 10.5, columns[1].width - 12);
    const rowHeight = Math.max(38, 22 + descriptionLines.length * 12);

    if (cursorY - rowHeight < minY && currentPageRows.length) {
      drawTableTotalRow(page, columns, cursorY, totalQuantity, totalAmount, layout);
      drawSignature(page, quotation, layout, cursorY - 34);
      page = createAnnexurePage(pdfDoc, templateImage, quotationData, quotation, layout, true);
      cursorY = 612;
      currentPageRows = [];
    }

    drawPriceRow(page, columns, cursorY, rowHeight, {
      sr: index + 1,
      descriptionLines,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      amount: item.amount,
    }, layout);
    currentPageRows.push(item);
    cursorY -= rowHeight;
  });

  drawTableTotalRow(page, columns, cursorY, totalQuantity, totalAmount, layout);
  drawSignature(page, quotation, layout, cursorY - 34);
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
    { label: "Sr.no.", x: 30, width: 42 },
    { label: "Item", x: 72, width: 335 },
    { label: "Qty.", x: 407, width: 30 },
    { label: "Unit", x: 437, width: 54 },
    { label: "Amount.", x: 491, width: 74 },
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
  drawCellText(page, formatIndianNumber(row.unitPrice), columns[3].x, y - height / 2 - 4, columns[3].width - 5, 10.5, layout.regularFont, "right");
  drawCellText(page, formatIndianNumber(row.amount), columns[4].x, y - height / 2 - 4, columns[4].width - 5, 10.5, layout.regularFont, "right");
}

function drawTableTotalRow(page, columns, y, totalQuantity, totalAmount, layout) {
  const height = 18;
  drawTableGrid(page, columns, y, height);
  drawCellText(page, formatQuantity(totalQuantity), columns[2].x, y - 13, columns[2].width, 11, layout.boldFont, "center");
  drawCellText(page, "TOTAL", columns[3].x, y - 13, columns[3].width, 11, layout.boldFont, "center");
  drawCellText(page, formatIndianNumber(totalAmount), columns[4].x, y - 13, columns[4].width - 5, 11, layout.boldFont, "right");
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
