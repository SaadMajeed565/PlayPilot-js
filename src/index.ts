import app from './api/server.js';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { TaskScheduler } from './core/TaskScheduler.js';
import { initBrowserStreamServer } from './api/browserStream.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

// Import managers from server (they're exported for shared use)
// This ensures we use the same instances
import { 
  jobManager, 
  knowledgeBase, 
  pipeline, 
  websiteManager, 
  sessionManager,
  scheduledTaskManager
} from './api/server.js';

// Initialize and start task scheduler
const taskScheduler = new TaskScheduler(
  scheduledTaskManager,
  websiteManager,
  sessionManager,
  knowledgeBase,
  jobManager,
  pipeline
);

// Start scheduler
taskScheduler.start();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  taskScheduler.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  taskScheduler.stop();
  process.exit(0);
});

// Create HTTP server (needed for WebSocket)
const server = createServer(app);

// Initialize WebSocket server for browser streaming
initBrowserStreamServer(server);

// Start server
server.listen(PORT, () => {
  console.log(`🚀 AI Web Automation API server running on port ${PORT}`);
  console.log(`📝 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 API docs: http://localhost:${PORT}/api/jobs`);
  console.log(`🌐 WebSocket: ws://localhost:${PORT}/api/browser-stream`);
});

