// Loaded with --require before the tests. env.ts refuses to load without these.
// Values set here win over anything in a developer's real .env (dotenv doesn't override).
process.env.MONGODB_URI = 'mongodb://localhost:27017/indexmenow-test';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
process.env.PUBLISH_CREDENTIAL_MODE = 'platform_first';
