// server.js

// 1. Import necessary packages
require('dotenv').config(); // Loads environment variables from a .env file
const express = require('express');
const axios = require('axios');
const mysql = require('mysql2/promise');
const cors = require('cors');

// 2. Initialize Express App and configure URLs
const app = express();
const PORT = process.env.PORT || 10000; // Render provides the PORT env var
const FRONTEND_URL = process.env.FRONTEND_URL;
const BACKEND_URL = process.env.BACKEND_URL;

// 3. Setup Middleware
if (!FRONTEND_URL) {
    console.error("FATAL ERROR: FRONTEND_URL environment variable is not set.");
    process.exit(1); // Exit if critical configuration is missing
}
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

// 4. Database Connection Pool
let dbPool;
try {
    dbPool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 20000
    });
    console.log("Database connection pool configured.");
} catch (error) {
    console.error("FATAL ERROR: Failed to configure database connection pool.", error);
    process.exit(1);
}

// Function to test the database connection
async function testDbConnection() {
    try {
        const connection = await dbPool.getConnection();
        console.log("Database connection pool created successfully and test connection acquired.");
        connection.release();
        return true;
    } catch (error) {
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("!!! FATAL ERROR: Could not connect to the database. !!!");
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("Error Details:", error.message);
        return false;
    }
}


// 5. Routes
// ROUTE 0: Health Check - To verify the server is running
app.get('/', (req, res) => {
  console.log("Health check endpoint '/' was hit.");
  res.status(200).send('Backend is running! Health check OK.');
});

// ROUTE 1: Redirects the user to LinkedIn's authorization page
app.get('/auth/linkedin', (req, res) => {
  console.log("Auth endpoint '/auth/linkedin' was hit.");
  // Using a basic scope to ensure the connection works without needing advanced product approval.
  // Once approved for "Community Management API", you can add 'r_member_social' back.
  const scope = 'r_liteprofile'; 
  const redirectUri = `${BACKEND_URL}/auth/linkedin/callback`;
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

// ROUTE 2: LinkedIn redirects the user here after authorization
app.get('/auth/linkedin/callback', async (req, res) => {
  console.log("Callback endpoint '/auth/linkedin/callback' was hit.");
  const { code } = req.query;

  if (!code) {
    console.error("Callback error: No authorization code received.");
    return res.redirect(`${FRONTEND_URL}/settings?error=true`);
  }

  try {
    const tokenResponse = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', null, {
      params: {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: `${BACKEND_URL}/auth/linkedin/callback`,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, expires_in } = tokenResponse.data;
    const expires_at = new Date();
    expires_at.setSeconds(expires_at.getSeconds() + expires_in);
    
    const userId = 'default_user'; // For this single-user app
    await dbPool.execute(
      'INSERT INTO linkedin_auth (user_id, access_token, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE access_token = ?, expires_at = ?',
      [userId, access_token, expires_at, access_token, expires_at]
    );

    console.log("Successfully retrieved and saved access token.");
    res.redirect(`${FRONTEND_URL}/settings?connected=true`);

  } catch (error) {
    console.error('Error during OAuth callback:', error.response ? error.response.data : error.message);
    res.redirect(`${FRONTEND_URL}/settings?error=true`);
  }
});

// ROUTE 3: Check connection status
app.get('/api/status', async (req, res) => {
    console.log("Status endpoint '/api/status' was hit.");
    try {
        const [rows] = await dbPool.execute('SELECT 1 FROM linkedin_auth WHERE user_id = ?', ['default_user']);
        res.json({ isConnected: rows.length > 0 });
    } catch (error) {
        console.error("Error checking status:", error.message);
        res.status(500).json({ isConnected: false });
    }
});


// ROUTE 4: The frontend calls this endpoint to get posts
app.get('/api/posts', async (req, res) => {
    console.log("Posts endpoint '/api/posts' was hit.");
    try {
        const [rows] = await dbPool.execute('SELECT access_token FROM linkedin_auth WHERE user_id = ?', ['default_user']);
        if (rows.length === 0) {
            return res.status(401).json({ message: 'Not authenticated. Please connect to LinkedIn.' });
        }
        const accessToken = rows[0].access_token;
        
        // 1. Get the authenticated user's ID (URN)
        const profileResponse = await axios.get('https://api.linkedin.com/v2/me', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const userUrn = profileResponse.data.id;
        
        // 2. Use the URN to fetch their posts
        // NOTE: This requires the 'r_member_social' permission, which needs product approval.
        // It will fail until you are approved for the "Community Management API".
        const postsApiUrl = `https://api.linkedin.com/v2/shares?q=owners&owners=urn:li:person:${userUrn}&count=15`;

        const postsResponse = await axios.get(postsApiUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'X-Restli-Protocol-Version': '2.0.0'
            }
        });
        
        // This is a simplification. You'll need to map the complex response from LinkedIn
        // to the simple 'Post' structure your frontend expects.
        const formattedPosts = postsResponse.data.elements.map(post => {
            const commentary = post.specificContent['com.linkedin.ugc.ShareContent']?.shareCommentary?.text || '';
            const createdDate = new Date(post.created.time).toISOString().split('T')[0];

            // Dummy data for metrics that require more complex API calls
            return {
                id: post.id,
                content: commentary,
                imageUrl: `https://picsum.photos/800/400?random=${Math.floor(Math.random() * 1000)}`,
                impressions: Math.floor(Math.random() * 5000) + 500,
                reactions: {
                    likes: Math.floor(Math.random() * 100),
                    celebrations: Math.floor(Math.random() * 20),
                    loves: Math.floor(Math.random() * 15),
                    insights: Math.floor(Math.random() * 25),
                    funny: Math.floor(Math.random() * 5),
                },
                comments: Math.floor(Math.random() * 50),
                shares: Math.floor(Math.random() * 10),
                date: createdDate,
            };
        });

        res.json(formattedPosts);

    } catch(error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('Error fetching posts from LinkedIn:', errorMessage);
        
        if (error.response && error.response.status === 403) {
             return res.status(403).json({ message: 'Permission Denied. Ensure your LinkedIn App has been approved for the "Community Management API" product to read posts.' });
        }
        
        res.status(500).json({ message: `Failed to fetch posts. Server error: ${errorMessage}` });
    }
});


// 6. Start the server
async function startServer() {
    const isDbConnected = await testDbConnection();
    if (!isDbConnected) {
        console.error("Halting server startup due to database connection failure.");
        return;
    }
    
    // The '0.0.0.0' host is crucial for Render to route traffic correctly.
    app.listen(PORT, '0.0.0.0', () => {
      console.log("All routes have been registered.");
      console.log(`Backend server is running on http://0.0.0.0:${PORT}`);
    });
}

startServer();
