import { BridgeCoordinator } from './coordinator.js';
import { HttpIndexerApi } from './indexerClient.js';
import { createBridgeServer } from './server.js';

const PORT = Number(process.env.PORT ?? 8090);

const coordinator = new BridgeCoordinator(new HttpIndexerApi());
const server = createBridgeServer(coordinator);
server.listen(PORT, () => {
  console.log(`darkbox-bridge listening on :${PORT}`);
});

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { BridgeCoordinator } from './coordinator.js';
export { HttpIndexerApi } from './indexerClient.js';
export { createBridgeServer } from './server.js';
