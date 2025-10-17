// server.js

// 1. Import necessary packages
require('dotenv').config(); // Loads environment variables from a .env file
const express = require('express');
const axios = require('axios');
const mysql = require('mysql2/promise');
const cors = require('cors');

// 2. Initialize Express App
const app = express();
const PORT = process.env.PORT || 3001;

// 3. Setup Middleware
// Only allow requests from our frontend
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
};
app.use(cors(corsOptions)); 
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
    queueLimit: 0
  });
  console.log("Database connection pool created.");
} catch (error) {
  console.error("Failed to create database pool:", error);
}

// 5. Routes
// ROUTE 1: Redirects the user to LinkedIn's authorization page
app.get('/auth/linkedin', (req, res) => {
  // IMPORTANT: Temporarily changed scope to the basic 'r_liteprofile' for testing the connection.
  // This will allow the login to succeed without advanced permissions.
  // The original scope was 'r_liteprofile r_member_social'.
  const scope = 'r_liteprofile';
  // The redirect URI must point back to our deployed backend
  const redirectUri = `${process.env.BACKEND_URL}/auth/linkedin/callback`;
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

// ROUTE 2: LinkedIn redirects the user here after authorization
app.get('/auth/linkedin/callback', async (req, res) => {
  const { code } = req.query;
  const redirectUri = `${process.env.BACKEND_URL}/auth/linkedin/callback`;

  if (!code) {
    return res.status(400).redirect(`${process.env.FRONTEND_URL}/settings?error=true`);
  }

  try {
    const tokenResponse = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', null, {
      params: {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/x-form-urlencoded' }
    });

    const { access_token, expires_in } = tokenResponse.data;
    const expires_at = new Date();
    expires_at.setSeconds(expires_at.getSeconds() + expires_in);

    const userId = 'default_user';
    await dbPool.execute(
      'INSERT INTO linkedin_auth (user_id, access_token, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE access_token = ?, expires_at = ?',
      [userId, access_token, expires_at, access_token, expires_at]
    );

    // Redirect user back to the frontend settings page with a success indicator
    res.redirect(`${process.env.FRONTEND_URL}/settings?connected=true`);

  } catch (error) {
    console.error('Error during OAuth callback:', error.response ? error.response.data : error.message);
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=true`);
  }
});

// ROUTE 3: The frontend calls this endpoint to get posts
app.get('/api/posts', async (req, res) => {
    try {
        const [rows] = await dbPool.execute('SELECT access_token FROM linkedin_auth WHERE user_id = ?', ['default_user']);
        if (rows.length === 0) {
            return res.status(401).json({ message: 'Not authenticated. Please connect to LinkedIn.' });
        }
        const accessToken = rows[0].access_token;

        // Step 1: Get the authenticated user's profile to find their person URN
        const profileResponse = await axios.get('https://api.linkedin.com/v2/me', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const personUrn = `urn:li:person:${profileResponse.data.id}`;
        
        // NOTE: The following call will likely fail because we don't have the 'r_member_social' permission yet.
        // This is expected. The goal of the temporary fix is to confirm the connection works.
        const linkedInApiUrl = `https://api.linkedin.com/rest/posts?author=${personUrn}&q=author&count=15`;

        const apiResponse = await axios.get(linkedInApiUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'LinkedIn-Version': '202405' // Use a recent API version
            }
        });

        // The data structure from LinkedIn's REST API is complex.
        // This mapping will need to be adjusted based on the actual API response for personal posts.
        const formattedPosts = apiResponse.data.elements.map(post => {
            return {
                id: post.id,
                content: post.commentary || '',
                imageUrl: post.content?.media?.source?.downloadUrl || `https://picsum.photos/800/400?random=${Math.floor(Math.random()*1000)}`,
                impressions: 0, // Personal post APIs may not provide detailed insights
                reactions: { likes: 0, celebrations: 0, loves: 0, insights: 0, funny: 0 },
                comments: 0,
                shares: 0,
                date: new Date(post.createdAt).toISOString().split('T')[0],
            };
        });

        res.json(formattedPosts);

    } catch(error) {
        console.error('Error fetching posts from LinkedIn:', error.response ? error.response.data : error.message);
        // Provide a more helpful error message to the frontend.
        if (error.response && error.response.status === 403) {
            return res.status(403).json({ message: 'Authentication successful, but you do not have permission to access post data. Please ensure your LinkedIn App has the "Community Management API" product approved.' });
        }
        res.status(500).json({ message: 'Failed to fetch posts from LinkedIn API.' });
    }
});

app.get('/api/status', async (req, res) => {
  try {
    const [rows] = await dbPool.execute('SELECT 1 FROM linkedin_auth WHERE user_id = ?', ['default_user']);
    if (rows.length > 0) {
      res.json({ isConnected: true });
    } else {
      res.json({ isConnected: false });
    }
  } catch(error) {
    res.status(500).json({ isConnected: false, message: 'Could not check status.' });
  }
});


// 6. Start the server
app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
