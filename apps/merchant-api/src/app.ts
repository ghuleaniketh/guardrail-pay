import Fastify from 'fastify';
import cors from '@fastify/cors';
import { paidRoutes } from './routes/paid.js';
import { arkivRoutes } from './routes/arkiv.js';
import { rotationRoutes } from './routes/rotation.js';
import { worldRoutes } from './routes/world.js';
import { wellknownRoutes } from './routes/wellknown.js';
import { demoRoutes } from './routes/demo.js';

export function buildApp() {
  const server = Fastify();

  server.register(cors, {
    origin: true,
  });

  server.get('/health', async () => {
    return { status: 'ok', service: 'merchant-api' };
  });

  server.register(paidRoutes);
  server.register(arkivRoutes);
  server.register(rotationRoutes);
  server.register(worldRoutes);
  server.register(wellknownRoutes);
  server.register(demoRoutes);

  return server;
}
