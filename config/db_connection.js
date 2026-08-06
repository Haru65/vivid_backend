const pg = require('pg');
const { Pool } = pg;

const dotenv = require('dotenv');
dotenv.config();

// Create a new pool instance with your database configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "Production" ? { rejectUnauthorized: false}
    :false
});

// Export the pool for use in other modules
module.exports = pool;