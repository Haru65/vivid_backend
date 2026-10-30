const express = require('express');
const leadRouter = require('./routes/lead_dashboard');
const customerRouter = require('./routes/customers');
const quotationRouter = require('./routes/quotations');
const meetingRouter = require('./routes/meetings');
const taskRouter = require('./routes/tasks');
const approvalRouter = require('./routes/approvals');
const estimationRouter = require('./routes/estimation');
const notificationRouter = require('./routes/notifications');
const activityLogRouter = require('./routes/activityLogs');
const leadChangeRouter = require('./routes/leadChanges');
const erpRouter = require('./routes/erp');
const projectRouter = require('./routes/projects');
const settingsRouter = require('./routes/settings');
const authRouter = require('./routes/auth');
const profileRouter = require('./routes/profileRoute');
const { createSchemas } = require('./config/db_schema');
const { authenticateToken, validateAuthConfiguration } = require('./middleware/auth');
const { sendFridayTaskPlanningReminders } = require('./services/taskReminderService');


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
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-User-Name, X-User-Role, X-Quote-Value, X-File-Name'
  );

  res.header(
    'Access-Control-Expose-Headers',
    'Content-Disposition'
  );

  res.header(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'same-origin');
  res.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Middleware to parse JSON requests
app.use(express.json({ limit: '1mb' }));

app.use('/auth', authRouter);
app.use(authenticateToken);

app.use('/leads', leadRouter);
app.use('/customers', customerRouter);
app.use('/quotations', quotationRouter);
app.use('/meetings', meetingRouter);
app.use('/tasks', taskRouter);
app.use('/approvals', approvalRouter);
app.use('/estimation', estimationRouter);
app.use('/notifications', notificationRouter);
app.use('/activity-logs', activityLogRouter);
app.use('/lead-change-requests', leadChangeRouter);
app.use('/erp', erpRouter);
app.use('/projects', projectRouter);
app.use('/settings', settingsRouter);
app.use('/profile', profileRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Unhandled API error:', error);
  const status = error.type === 'entity.too.large' ? 413 : error.statusCode || 500;
  return res.status(status).json({
    error: status === 413 ? 'Request body is too large.' : status < 500 ? error.message : 'Unexpected server error.',
  });
});

async function startServer() {
  try {
    validateAuthConfiguration();
    await createSchemas();
    const runTaskPlanningReminders = () => sendFridayTaskPlanningReminders().catch((error) => console.error('Unable to send Friday task planning reminders:', error));
    runTaskPlanningReminders();
    setInterval(runTaskPlanningReminders, 60 * 60 * 1000).unref();
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
