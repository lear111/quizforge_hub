import { createPublicPreview } from '../cloud/public-preview.mjs';

const server = createPublicPreview();
server.listen(4322, '127.0.0.1', () => console.log('Hub-admin-protected cloud preview gateway ready on loopback port 4322'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
