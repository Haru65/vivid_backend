#!/bin/bash
# Quick script to fix visit_tasks table permissions

set -e

# Load DATABASE_URL from .env
if [ -f .env ]; then
    export $(cat .env | grep DATABASE_URL | xargs)
fi

if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL not found in .env"
    exit 1
fi

echo "Fixing permissions for visit_tasks and task_planning_reminders..."
psql "$DATABASE_URL" -f migrations/028_fix_visit_tasks_permissions.sql

echo "✅ Permissions fixed successfully!"
echo ""
echo "You can now restart your application:"
echo "  pm2 restart vivid"
