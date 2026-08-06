const express = require('express');
const leadRouter = require('./routes/lead_dashboard');
const customerRouter = require('./routes/customers');
const quotationRouter = require('./routes/quotations');
const { createSchemas } = require('./config/db_schema');





const app = express();
const port = process.env.PORT || 3001;

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (localOrigin) res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Middleware to parse JSON requests
app.use(express.json());

app.use('/leads', leadRouter);
app.use('/customers', customerRouter);
app.use('/quotations', quotationRouter);

async function startServer() {
  try {
    await createSchemas();
    const server = app.listen(port, () => {
      console.log(`Server is running on http://localhost:${port}`);
    });

    server.on('close', () => console.log('Server closed'));
    server.on('error', console.error);
  } catch (error) {
    console.error('Unable to initialize database schema:', error);
    process.exitCode = 1;
  }
}

startServer();
