const { PrismaClient } = require('@prisma/client');

// A single shared Prisma client for the whole app (best practice — avoids
// exhausting the database connection pool by creating a new client per request).
const prisma = new PrismaClient();

module.exports = prisma;
