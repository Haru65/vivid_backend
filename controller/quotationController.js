const pool = require("../config/db_connection");
const path = require("path");
const { generateQuotationPdf } = require("../services/quotationGeneration");

async function generateQuotation(id) {
    if (!id) {
        throw new Error("Quotation ID is required");
    }

    const result = await pool.query(
        "SELECT * FROM quotations WHERE quotation_number = $1",
        [id],
    );

    if (result.rows.length === 0) {
        throw new Error("Quotation not found");
    }

    const quotation = result.rows[0];

    try {
        const outputPath = path.join(__dirname, "../quotations", `${quotation.quotation_number}.pdf`);
        await generateQuotationPdf({
            quotationNumber: quotation.quotation_number,
            company_name: quotation.company_name,
            billing_name: quotation.billing_name,
            assigned_to: quotation.assigned_to,
            subject: quotation.subject,
            contact_person_name: quotation.contact_person_name,
            line_items: quotation.line_items,
        }, null, { outputPath });

        return {
            quotation_number: quotation.quotation_number,
            outputPath,
        };
    } catch (error) {
        console.error("Error generating quotation PDF:", error);
        throw error;
    }
}

module.exports = { generateQuotation };

if (require.main === module) {
    const quotationNumber = process.argv[2];

    if (!quotationNumber) {
        console.log("Usage: node controller/quotationController.js <quotation_number>");
        process.exitCode = 1;
    } else {
        generateQuotation(quotationNumber)
            .then((result) => {
                console.log(`Generated ${result.quotation_number}: ${result.outputPath}`);
                pool.end();
            })
            .catch((error) => {
                console.error(error.message);
                pool.end();
                process.exitCode = 1;
            });
    }
}
