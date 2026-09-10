const express = require('express');
const leadRouter = require('./routes/lead_dashboard');
const customerRouter = require('./routes/customers');
const quotationRouter = require('./routes/quotations');
const meetingRouter = require('./routes/meetings');
const approvalRouter = require('./routes/approvals');
const erpRouter = require('./routes/erp');
const projectRouter = require('./routes/projects');
const settingsRouter = require('./routes/settings');
const authRouter = require('./routes/auth');
const { createSchemas } = require('./config/db_schema');
const { authenticateToken } = require('./middleware/auth');


const dotenv = require('dotenv');
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use((req, res, next) => {
  const origin = req.headers.origin || '';

  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim());

  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-User-Name, X-User-Role'
  );

  res.header(
    'Access-Control-Expose-Headers',
    'Content-Disposition'
  );

  res.header(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,DELETE,OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Middleware to parse JSON requests
app.use(express.json());

app.use('/auth', authRouter);
app.use(authenticateToken);

app.use('/leads', leadRouter);
app.use('/customers', customerRouter);
app.use('/quotations', quotationRouter);
app.use('/meetings', meetingRouter);
app.use('/approvals', approvalRouter);
app.use('/erp', erpRouter);
app.use('/projects', projectRouter);
app.use('/settings', settingsRouter);

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
