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
const corsOptions = {
  origin: process.env.FRONTEND_URL,
};
if (!process.env.FRONTEND_URL) {
    console.warn("WARNING: FRONTEND_URL environment variable not set. CORS may block requests.");
} else {
    console.log(`CORS configured for origin: ${process.env.FRONTEND_URL}`);
}
app.use(cors(corsOptions));
app.use(express.json());


// 4. Database Connection Pool
let dbPool;
// Test database connection immediately on startup
const initializeDatabase = async () => {
    try {
        console.log("Attempting to create database connection pool...");
        dbPool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectTimeout: 10000 // 10 seconds
        });

        // Try to get a connection to see if credentials are valid
        const connection = await dbPool.getConnection();
        console.log("Database connection pool created successfully and test connection acquired.");
        connection.release(); // release the connection back to the pool
        return true;
    } catch (error) {
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("!!! FATAL ERROR: Could not connect to the database. !!!");
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("Error Details:", error.message);
        console.error("Please check your DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME environment variables on Render.");
        console.error("Also, ensure your database server allows remote connections from Render's IP addresses.");
        dbPool = null; // Set pool to null so we know it failed
        return false;
    }
};

// 5. Routes
// ROUTE 1: Redirects the user to LinkedIn's authorization page
app.get('/auth/linkedin', (req, res) => {
  console.log("Received request for /auth/linkedin");
  const scope = 'r_liteprofile';
  const redirectUri = `${process.env.BACKEND_URL}/auth/linkedin/callback`;
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

// ROUTE 2: LinkedIn redirects the user here after authorization
app.get('/auth/linkedin/callback', async (req, res) => {
  console.log("Received request for /auth/linkedin/callback");
  if (!dbPool) {
    console.error("Database not connected, cannot process callback.");
    return res.status(500).send("Server error: Database connection failed.");
  }
  
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

    res.redirect(`${process.env.FRONTEND_URL}/settings?connected=true`);

  } catch (error) {
    console.error('Error during OAuth callback:', error.response ? error.response.data : error.message);
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=true`);
  }
});

// Other API routes would go here...
app.get('/api/posts', async (req, res) => {
    console.log("Received request for /api/posts");
    if (!dbPool) {
        console.error("Database not connected, cannot fetch posts.");
        return res.status(500).json({ message: 'Server error: Database connection failed.' });
    }
    // ... rest of the function ...
    try {
        const [rows] = await dbPool.execute('SELECT access_token FROM linkedin_auth WHERE user_id = ?', ['default_user']);
        if (rows.length === 0) {
            return res.status(401).json({ message: 'Not authenticated. Please connect to LinkedIn.' });
        }
        const accessToken = rows[0].access_token;
        const profileResponse = await axios.get('https://api.linkedin.com/v2/me', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const personUrn = `urn:li:person:${profileResponse.data.id}`;
        const linkedInApiUrl = `https://api.linkedin.com/rest/posts?author=${personUrn}&q=author&count=15`;
        const apiResponse = await axios.get(linkedInApiUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'LinkedIn-Version': '202405'
            }
        });
        const formattedPosts = apiResponse.data.elements.map(post => ({
            id: post.id,
            content: post.commentary || '',
            imageUrl: post.content?.media?.source?.downloadUrl || `https://picsum.photos/800/400?random=${Math.floor(Math.random()*1000)}`,
            impressions: 0,
            reactions: { likes: 0, celebrations: 0, loves: 0, insights: 0, funny: 0 },
            comments: 0,
            shares: 0,
            date: new Date(post.createdAt).toISOString().split('T')[0],
        }));
        res.json(formattedPosts);
    } catch(error) {
        console.error('Error fetching posts from LinkedIn:', error.response ? error.response.data : error.message);
        if (error.response && error.response.status === 403) {
            return res.status(403).json({ message: 'Authentication successful, but you do not have permission to access post data. Please ensure your LinkedIn App has the "Community Management API" product approved.' });
        }
        res.status(500).json({ message: 'Failed to fetch posts from LinkedIn API.' });
    }
});

app.get('/api/status', async (req, res) => {
    console.log("Received request for /api/status");
    if (!dbPool) {
      return res.json({ isConnected: false });
    }
    try {
      const [rows] = await dbPool.execute('SELECT 1 FROM linkedin_auth WHERE user_id = ?', ['default_user']);
      res.json({ isConnected: rows.length > 0 });
    } catch(error) {
      console.error("Error in /api/status:", error.message);
      res.status(500).json({ isConnected: false, message: 'Could not check status.' });
    }
});


// 6. Start the server
const startServer = async () => {
    const dbReady = await initializeDatabase();
    if (dbReady) {
        app.listen(PORT, () => {
          console.log(`Backend server is running on http://localhost:${PORT}`);
        });
    } else {
        console.error("SERVER NOT STARTED due to database connection failure.");
        // We can create a fallback route to inform the user
        app.get('*', (req, res) => {
            res.status(503).send('Service Unavailable: Could not connect to the database.');
        });
        app.listen(PORT, () => {
          console.log(`Backend server is running in a DEGRADED state on http://localhost:${PORT}`);
        });
    }
};

startServer();
