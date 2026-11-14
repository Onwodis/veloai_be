/**
 * Prisma CLI configuration. The schema lives with the rest of the data layer
 * in src/models; migrations sit beside it. A config file disables Prisma's
 * own .env loading, so dotenv is loaded explicitly.
 */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'src/models/schema.prisma',
  migrations: {
    path: 'src/models/migrations',
  },
});
