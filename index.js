require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Resend } = require('resend');

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Define JWT_SECRET at the top level
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Verify JWT secret at startup
console.log('Application starting...');
console.log('Environment:', process.env.NODE_ENV);
console.log('JWT_SECRET from env:', process.env.JWT_SECRET);
console.log('JWT_SECRET constant:', JWT_SECRET);

// Test JWT signing and verification
try {
  const testToken = jwt.sign({ test: 'data' }, JWT_SECRET);
  const verified = jwt.verify(testToken, JWT_SECRET);
  console.log('JWT test successful - secret is working correctly');
} catch (error) {
  console.error('JWT test failed:', error);
  process.exit(1); // Exit if JWT is not working
}

// PostgreSQL Configuration
const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  // Connection pool settings
  max: 10, // Maximum number of clients
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  connectionTimeoutMillis: 5000, // Connection timeout after 5 seconds
  maxUses: 7500, // Close connection after it has been used this many times
};

// Only enable SSL in production
if (process.env.NODE_ENV === 'production' && process.env.PGSSLMODE !== 'disable') {
  poolConfig.ssl = {
    rejectUnauthorized: false
  };
}

console.log(`Database SSL mode: ${poolConfig.ssl ? 'enabled' : 'disabled'}`);

const pool = new Pool(poolConfig);
// Set the search path for all queries
pool.on('connect', (client) => {
  client.query('SET search_path TO deuss');
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to the database:', err);
  } else {
    // Successfully connected to PostgreSQL database
    
    // First, explicitly check if the session table exists
    client.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables 
        WHERE schemaname = 'deuss' 
        AND tablename = 'session'
      )
    `, (err, result) => {
      if (err) {
        console.error('Error checking session table existence:', err);
        release();
        return;
      }
      
      const tableExists = result.rows[0].exists;
      
      if (!tableExists) {
        // Create session table if it doesn't exist in the deuss schema
        client.query(`
          CREATE TABLE IF NOT EXISTS deuss.session (
            sid VARCHAR NOT NULL,
            sess JSON NOT NULL,
            expire TIMESTAMP(6) NOT NULL
          )`, (err) => {
          if (err) {
            console.error('Error creating session table:', err);
            release();
            return;
          }
          
          // Create the primary key separately with IF NOT EXISTS
          client.query(`
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
              ) THEN
                ALTER TABLE deuss.session ADD CONSTRAINT session_pkey PRIMARY KEY (sid);
              END IF;
            END$$;
          `, (err) => {
            if (err) {
              console.error('Error creating primary key constraint:', err);
              release();
              return;
            }
            
            // Create index on expire
            client.query(`
              CREATE INDEX IF NOT EXISTS idx_session_expire ON deuss.session (expire);
            `, (err) => {
              if (err) {
                console.error('Error creating expire index:', err);
              }
              release();
            });
          });
        });
      } else {
        release();
      }
    });
  }
});

// Configure pool error handling to prevent crashes
pool.on('error', (err) => {
  console.error('Unexpected error on PostgreSQL pool', err);
});

// Express Configuration
const app = express();
const PORT = process.env.PORT || 3000;


// Improve CORS configuration to better handle cookies
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true, parameterLimit: 50000 }));
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    
    // Check if the origin is allowed
    if (process.env.NODE_ENV === 'production') {
      // In production, check against production domains
      const prodOrigins = [
        'https://deuss.space',
        'https://homepage.deuss.space',
      ];
      
      // Check if origin matches any production domains
      const originAllowed = prodOrigins.some(allowedOrigin => {
        return origin.includes(allowedOrigin) || allowedOrigin.includes(origin);
      });
      
      if (originAllowed) {
        return callback(null, true);
      } else {
        console.warn(`CORS blocked request from ${origin}`);
        return callback(new Error('Not allowed by CORS'), false);
      }
    } else {
      // In development, allow all localhost origins
      if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
        return callback(null, true);
      } else {
        console.warn(`CORS blocked request from ${origin}`);
        return callback(new Error('Not allowed by CORS'), false);
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Session configuration with multiple fallback mechanisms
const initSessionStore = async () => {
  try {
    // First try: Use connect-pg-simple with the correct schema and table name
    return new pgSession({
      pool,
      tableName: 'session',  // Table name without schema prefix
      schemaName: 'deuss', // Schema name
      createTableIfMissing: false,
      errorLog: (error) => {
        console.error('Session store error:', error);
        if (error.code === '42P07') { // duplicate_table
          console.warn('Ignoring duplicate table error');
        }
      }
    });
  } catch (primaryError) {
    console.error('Failed to initialize primary session store:', primaryError);
    
    try {
      // Second try: Use connect-pg-simple with fully-qualified name but no schema param
      return new pgSession({
        pool,
        tableName: 'deuss.session', // Fully qualified table name
        createTableIfMissing: false
      });
    } catch (secondaryError) {
      console.error('Failed to initialize secondary session store:', secondaryError);
      
      // Last resort: Use memory store
      console.warn('FALLBACK: Using in-memory session store. Sessions will be lost on server restart.');
      const MemoryStore = session.MemoryStore;
      return new MemoryStore();
    }
  }
};

// Initialize session store
let sessionStore;
(async () => {
  try {
    sessionStore = await initSessionStore();
    
    // Attach error handler if supported
    if (sessionStore.on) {
      sessionStore.on('error', (error) => {
        console.error('Session store error event:', error);
        // Attempt to reconnect if possible
        if (typeof sessionStore.connect === 'function') {
          setTimeout(() => {
            try {
              sessionStore.connect();
            } catch (e) {
              console.error('Failed to reconnect session store:', e);
            }
          }, 5000);
        }
      });
    }
    
    // Setup domain for cookies
    const cookieDomain = process.env.NODE_ENV === 'production' 
      ? process.env.COOKIE_DOMAIN || '.deuss.space' // Use cookie domain for production 
      : undefined; // No domain for localhost
    
    // Initialize session middleware with the store with improved cookie settings
    const sessionConfig = {
      store: sessionStore,
      secret: process.env.SESSION_SECRET || 'your-secret-key',
      resave: false,
      saveUninitialized: false,
      name: 'deuss.sid', // Use a custom cookie name
      genid: function(req) {
        return uuidv4(); // Use UUID for session IDs
      },
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days for longer persistence
        domain: cookieDomain,
        path: '/',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
      }
    };
    
    // In development, don't set secure flag even with sameSite none
    if (process.env.NODE_ENV !== 'production') {
      sessionConfig.cookie.secure = false;
    }
    
    app.use(session(sessionConfig));
    
    // Session-related middleware...
    // Handle potential session store errors
    app.use((req, res, next) => {
      // If session middleware failed to initialize req.session
      if (!req.session) {
        console.error('Session initialization failed for this request');
        
        // Create a minimal dummy session object to prevent crashes
        req.session = {
          // Keep it empty but allow properties to be set
          _isTemporary: true,
          save: (callback) => {
            if (typeof callback === 'function') {
              callback();
            }
          },
          destroy: (callback) => {
            if (typeof callback === 'function') {
              callback();
            }
          },
          touch: () => {}
        };
        
        // Add JWT auth header to request if available
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          try {
            const token = authHeader.substring(7);
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = decoded;
            // Set user ID from JWT in our dummy session
            req.session.uid = decoded.id;
          } catch (error) {
            console.error('JWT verification failed:', error);
          }
        }
      }
      next();
    });
    
    // Add error handling for session failures
    app.use((err, req, res, next) => {
      // Handle session-specific errors
      if (err.code === 'EBADSESSION') {
        console.error('Session error:', err);
        
        // Safely handle session destruction
        try {
          if (req.session && typeof req.session.destroy === 'function') {
            req.session.destroy();
          } else {
            // If session can't be properly destroyed, recreate it as an empty object
            req.session = {
              _isTemporary: true,
              save: (callback) => { if (typeof callback === 'function') callback(); },
              destroy: (callback) => { if (typeof callback === 'function') callback(); },
              touch: () => {}
            };
          }
        } catch (sessionErr) {
          console.error('Error during session recovery:', sessionErr);
          // Last resort - just set it to null
          req.session = null;
        }
        
        return next();
      }
      
      // Handle PostgreSQL connection errors gracefully
      if (err.code && ['57P01', '57P02', '57P03', '57P04'].includes(err.code)) {
        console.error('PostgreSQL connection error:', err);
        // Don't crash the server, let the request continue
        return next();
      }
      
      next(err);
    });
    
    // Middleware to check JWT if session fails
    app.use((req, res, next) => {
      if (!req.session || !req.session.uid) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          try {
            const token = authHeader.substring(7);
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = decoded;
          } catch (error) {
            console.error('JWT verification failed:', error);
          }
        }
      }
      next();
    });
    
  } catch (error) {
    console.error('Failed to initialize session middleware:', error);
    process.exit(1); // Critical error - exit the application
  }
})();

// Create a health check endpoint to verify database connection
app.get('/api/health', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      res.status(200).json({ status: 'ok', database: 'connected' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ status: 'error', message: 'Database connection failed', database: 'disconnected' });
  }
});

// Add middleware to check if session store is working
app.use((req, res, next) => {
  // Check if the session fails to load
  if (!req.session && req.sessionStore && req.sessionStore.connected === false) {
    console.warn('Session store appears to be disconnected');
    
    // Attempt to reconnect
    if (typeof req.sessionStore.connect === 'function') {
      req.sessionStore.connect();
    }
  }
  next();
});

// Middleware to require login
const loginRequired = (req, res, next) => {
  // First try to get user ID from session
  let userId = null;
  
  if (req.session?.uid) {
    userId = req.session.uid;
    next();
    return;
  }
  
  // If no session, try JWT from Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && decoded.id) {
        userId = decoded.id;
        
        // Set user info on request
        req.user = decoded;
        
        // If JWT authentication is used but no session, create a session
        if (!req.session) {
          console.warn('No session available when using JWT auth');
        } else if (!req.session.uid) {
          // Store the user ID in the session for future requests
          req.session.uid = userId;
          if (typeof req.session.save === 'function') {
            req.session.save((err) => {
              if (err) {
                console.error('Error saving session from JWT:', err);
              }
            });
          }
        }
        
        next();
        return;
      }
    } catch (error) {
      console.error('JWT verification failed:', error);
      // Continue to next authentication check
    }
  }
  
  // Try cookie-based JWT as last resort
  try {
    const cookies = req.headers.cookie;
    if (cookies) {
      const cookieTokenMatch = cookies.match(/jwt=([^;]+)/);
      if (cookieTokenMatch && cookieTokenMatch[1]) {
        const token = cookieTokenMatch[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.id) {
          userId = decoded.id;
          
          // Set user info on request
          req.user = decoded;
          
          // If cookie JWT authentication is used but no session, create a session
          if (!req.session) {
            console.warn('No session available when using cookie JWT auth');
          } else if (!req.session.uid) {
            // Store the user ID in the session for future requests
            req.session.uid = userId;
            if (typeof req.session.save === 'function') {
              req.session.save((err) => {
                if (err) {
                  console.error('Error saving session from cookie JWT:', err);
                }
              });
            }
          }
          
          next();
          return;
        }
      }
    }
  } catch (error) {
    console.error('Cookie JWT verification failed:', error);
  }
  
  // No valid authentication found
  res.status(401).json({ 
    error: 'Authentication required',
    details: 'No valid session or token found'
  });
};

// Function to send verification email
async function sendVerificationEmail(email, token) {
  if (process.env.EMAIL_VERIFICATION !== 'true') {
    console.log('Development mode: Skipping email verification');
    return;
  }

  const verificationUrl = `${process.env.FRONTEND_URL}/auth/verify-email?token=${token}`;
  
  try {
    // Verify Resend configuration
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY environment variable is not set');
    }

    // Use Resend's default domain if custom domain is not verified
    const fromEmail = process.env.SMTP_FROM || 'Deuss <onboarding@resend.dev>';

    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: 'Verify your email address for Deuss',
      html: `
        <div style="font-family: sans-serif; background-color: #1a202c; color: #e2e8f0; padding: 20px;">
          <h1 style="color: #4299e1;">Welcome to Deuss!</h1>
          <p>Hello there,</p>
          <p>Thank you for joining the Deuss community! To unlock your full cybersecurity dashboard experience, you just need to verify your email address.</p>
          <p>Please click the button below to verify your account:</p>
          <p>
            <a href="${verificationUrl}" style="display: inline-block; background-color: #2d3748; color: #4299e1; padding: 10px 20px; text-decoration: none; border-radius: 5px; border: 1px solid #4299e1;">
              Verify Your Email Address
            </a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p><code style="color: #e2e8f0; background-color: #2d3748; padding: 5px; border-radius: 3px;">${verificationUrl}</code></p>
          <p>This link will expire in 24 hours for security reasons.</p>
          <p>If you did not sign up for Deuss, please disregard this email.</p>
          <p>Stay secure,</p>
          <p>The Deuss Team</p>
        </div>
      `
    });

    if (error) {
      console.error('Error sending verification email:', error);
      throw new Error(`Failed to send verification email: ${error.message}`);
    }

    console.log('Verification email sent:', data);
  } catch (error) {
    console.error('Error sending verification email:', error);
    throw error;
  }
}

// Authentication Routes
app.post('/api/auth/register', async (req, res) => {
  const { email, password, fullName } = req.body;

  if (!email || !password || !fullName) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    // Check if user already exists
    const userExists = await pool.query(
      'SELECT * FROM deuss.users WHERE email = $1',
      [email]
    );

    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create user with verification token
    const result = await pool.query(
      `INSERT INTO deuss.users (
        email, password, full_name, verification_token, 
        verification_token_expiry, is_verified, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) 
      RETURNING id, email, full_name, is_verified`,
      [email, hashedPassword, fullName, verificationToken, verificationTokenExpiry, false]
    );

    // Send verification email in production
    if (process.env.EMAIL_VERIFICATION === 'true') {
      try {
        await sendVerificationEmail(email, verificationToken);
      } catch (emailError) {
        console.error('Failed to send verification email:', emailError);
        // Don't fail registration if email fails
      }
    }

    res.status(201).json({
      message: 'User registered successfully. Please check your email to verify your account.',
      user: {
        id: result.rows[0].id,
        email: result.rows[0].email,
        fullName: result.rows[0].full_name,
        is_verified: result.rows[0].is_verified
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Add email verification endpoint
app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Verification token is required' });
  }

  try {
    // Find user with this token
    const result = await pool.query(
      `SELECT id, email, verification_token_expiry 
       FROM deuss.users 
       WHERE verification_token = $1 AND is_verified = false`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    const user = result.rows[0];

    // Check if token has expired
    if (new Date() > new Date(user.verification_token_expiry)) {
      return res.status(400).json({ error: 'Verification token has expired' });
    }

    // Update user as verified
    await pool.query(
      `UPDATE deuss.users 
       SET is_verified = true, 
           verification_token = NULL, 
           verification_token_expiry = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ 
      success: false,
      message: 'Email and password are required' 
    });
  }

  try {
    // Get user
    const result = await pool.query(
      'SELECT * FROM deuss.users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ 
        success: false,
        message: 'Invalid credentials' 
      });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ 
        success: false,
        message: 'Invalid credentials' 
      });
    }

    // Check email verification in production
    if (process.env.EMAIL_VERIFICATION === 'true' && !user.is_verified) {
      // Generate new verification token if needed
      if (!user.verification_token || new Date() > new Date(user.verification_token_expiry)) {
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        await pool.query(
          `UPDATE deuss.users 
           SET verification_token = $1, 
               verification_token_expiry = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [verificationToken, verificationTokenExpiry, user.id]
        );

        // Send new verification email
        try {
          await sendVerificationEmail(user.email, verificationToken);
        } catch (emailError) {
          console.error('Failed to send verification email:', emailError);
        }
      }

      return res.status(403).json({
        success: false,
        message: 'Please verify your email before logging in',
        needsVerification: true
      });
    }

    // Generate JWT with extended expiration for persistent auth
    console.log('Creating JWT token with secret:', JWT_SECRET);
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email,
        full_name: user.full_name,
        tier: user.tier || 'basic',
        is_verified: user.is_verified || false,
      },
      JWT_SECRET,
      { expiresIn: '30d' } // 30 days to match cookie
    );
    console.log('JWT token created successfully');

    // Format user data - used in all response scenarios
    const formattedUser = {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      avatar_url: user.avatar_url,
      tier: user.tier || 'basic',
      is_verified: user.is_verified || false,
      created_at: user.created_at,
      updated_at: user.updated_at,
      initials: getInitials(user.full_name)
    };

    // Try to set the session, but don't fail if it doesn't work
    let sessionStatus = 'active';
    let sessionID = null;
    
    try {
      if (!req.session) {
        console.warn('Session object not available during login');
        sessionStatus = 'unavailable';
      } else {
        req.session.uid = user.id;
        sessionID = req.sessionID;
        
        // Test that the session is working by reading back the value we just set
        if (req.session.uid !== user.id) {
          console.warn('Session appears to be non-functional - value not persisted');
          sessionStatus = 'non-functional';
        }
        
        // Try to save the session explicitly
        if (typeof req.session.save === 'function') {
          await new Promise((resolve) => {
            req.session.save((err) => {
              if (err) {
                console.error('Error saving session:', err);
                sessionStatus = 'error-saving';
              }
              resolve();
            });
          });
        }
      }
    } catch (sessionError) {
      console.error('Error setting/saving session:', sessionError);
      sessionStatus = 'error';
    }

    // Add Set-Cookie header manually as a backup
    res.setHeader('Set-Cookie', [
      `jwt=${token}; Max-Age=${30 * 24 * 60 * 60}; Path=/; HttpOnly; ${process.env.NODE_ENV === 'production' ? 'Secure; SameSite=None' : ''}`
    ]);

    // Send response with token and session details
    res.json({
      success: true,
      message: 'Logged in successfully',
      user: formattedUser,
      token, // Include JWT token for client-side storage
      sessionStatus,
      sessionID,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to login',
      error: error.message 
    });
  }
});

// Helper function to get initials
function getInitials(name) {
  if (!name) return '';
  return name
    .split(' ')
    .map(word => word.charAt(0))
    .join('')
    .toUpperCase();
}

app.post('/api/auth/logout', loginRequired, (req, res) => {
  // Check if session exists and has destroy method
  if (!req.session || typeof req.session.destroy !== 'function') {
    return res.json({ message: 'Session already destroyed or invalid' });
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).json({ error: 'Could not logout' });
    }
    return res.json({ message: 'Logged out successfully' });
  });
});

// Bookmarks Routes
app.get('/api/bookmarks', loginRequired, async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if default bookmarks have been added for this user
    const userResult = await pool.query(
      'SELECT default_bookmarks_added FROM deuss.users WHERE id = $1',
      [userId]
    );
    
    const defaultBookmarksAdded = userResult.rows[0]?.default_bookmarks_added || false;
    
    // If default bookmarks haven't been added yet, add them
    if (!defaultBookmarksAdded) {
      await addDefaultBookmarksForUser(userId);
    }

    // Get bookmark categories
    const categoriesResult = await pool.query(
      'SELECT * FROM deuss.bookmark_categories WHERE user_id = $1 ORDER BY id',
      [userId]
    );

    // Get bookmarks
    const bookmarksResult = await pool.query(
      'SELECT * FROM deuss.bookmarks WHERE user_id = $1 ORDER BY id',
      [userId]
    );

    // Group bookmarks by category
    const categoriesWithBookmarks = categoriesResult.rows.map(category => ({
      ...category,
      bookmarks: bookmarksResult.rows.filter(bookmark => bookmark.category_id === category.id)
    }));

    res.json({
      categories: categoriesWithBookmarks,
      bookmarks: bookmarksResult.rows
    });

  } catch (error) {
    console.error('Error fetching bookmarks:', error);
    res.status(500).json({
      error: 'Failed to fetch bookmarks',
      message: error.message,
      bookmarks: []
    });
  }
});

// Add a new bookmark
app.post('/api/bookmarks', loginRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { title, url, category_id, color } = req.body;

    if (!title || !url || !category_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Convert category_id to integer
    const categoryIdInt = parseInt(category_id, 10);
    
    if (isNaN(categoryIdInt)) {
      return res.status(400).json({ 
        error: 'Invalid category ID',
        details: 'Category ID must be a valid integer'
      });
    }

    // Validate that the category belongs to the user
    const categoryCheck = await pool.query(
      'SELECT id FROM deuss.bookmark_categories WHERE id = $1 AND user_id = $2',
      [categoryIdInt, userId]
    );

    if (categoryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found or does not belong to user' });
    }

    // Insert the bookmark
    const result = await pool.query(
      'INSERT INTO deuss.bookmarks (user_id, category_id, title, url, color, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING *',
      [userId, categoryIdInt, title, url, color]
    );

    res.status(201).json({ 
      message: 'Bookmark added successfully',
      bookmark: result.rows[0]
    });

  } catch (error) {
    console.error('Error adding bookmark:', error);
    res.status(500).json({ 
      error: 'Failed to add bookmark',
      message: error.message
    });
  }
});

// Update a bookmark
app.put('/api/bookmarks/:id', loginRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookmarkId = parseInt(req.params.id, 10);
    if (isNaN(bookmarkId)) {
      return res.status(400).json({ 
        error: 'Invalid bookmark ID',
        details: 'Bookmark ID must be a valid integer'
      });
    }

    const { title, url, category_id, color } = req.body;

    if (!title || !url || !category_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Convert category_id to integer
    const categoryIdInt = parseInt(category_id, 10);
    if (isNaN(categoryIdInt)) {
      return res.status(400).json({ 
        error: 'Invalid category ID',
        details: 'Category ID must be a valid integer'
      });
    }

    // Verify bookmark belongs to user
    const bookmarkCheck = await pool.query(
      'SELECT id FROM deuss.bookmarks WHERE id = $1 AND user_id = $2',
      [bookmarkId, userId]
    );

    if (bookmarkCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Bookmark not found or does not belong to user' });
    }

    // Verify category belongs to user
    const categoryCheck = await pool.query(
      'SELECT id FROM deuss.bookmark_categories WHERE id = $1 AND user_id = $2',
      [categoryIdInt, userId]
    );

    if (categoryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found or does not belong to user' });
    }

    // Update the bookmark
    const result = await pool.query(
      'UPDATE deuss.bookmarks SET title = $1, url = $2, category_id = $3, color = $4, updated_at = NOW() WHERE id = $5 AND user_id = $6 RETURNING *',
      [title, url, categoryIdInt, color, bookmarkId, userId]
    );

    res.json({
      message: 'Bookmark updated successfully',
      bookmark: result.rows[0]
    });

  } catch (error) {
    console.error('Error updating bookmark:', error);
    res.status(500).json({ 
      error: 'Failed to update bookmark',
      message: error.message
    });
  }
});

// Delete a bookmark
app.delete('/api/bookmarks/:id', loginRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bookmarkId = parseInt(req.params.id, 10);
    if (isNaN(bookmarkId)) {
      return res.status(400).json({ 
        error: 'Invalid bookmark ID',
        details: 'Bookmark ID must be a valid integer'
      });
    }

    // Verify bookmark belongs to user
    const bookmarkCheck = await pool.query(
      'SELECT id FROM deuss.bookmarks WHERE id = $1 AND user_id = $2',
      [bookmarkId, userId]
    );

    if (bookmarkCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Bookmark not found or does not belong to user' });
    }

    // Delete the bookmark
    await pool.query(
      'DELETE FROM deuss.bookmarks WHERE id = $1 AND user_id = $2',
      [bookmarkId, userId]
    );

    res.json({ message: 'Bookmark deleted successfully' });

  } catch (error) {
    console.error('Error deleting bookmark:', error);
    res.status(500).json({ 
      error: 'Failed to delete bookmark',
      message: error.message
    });
  }
});

// Add a new bookmark category
app.post('/api/bookmarks/category', loginRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { name, icon, id } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    // Check if this is an update or new category
    if (id) {
      // Check if this looks like a temporary timestamp-based ID from the frontend
      // Timestamp IDs are usually 13+ digits, which is too large for PostgreSQL INT
      if (String(id).length > 10) {
        // Create a new category instead of trying to update a non-existent one
        const result = await pool.query(
          'INSERT INTO deuss.bookmark_categories (user_id, name, icon, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
          [userId, name, icon || 'wrench']
        );

        return res.status(201).json({
          message: 'Category created successfully',
          category: result.rows[0]
        });
      } else {
        // Attempt to update an existing category
        // First, verify the category belongs to this user
        const existingCategory = await pool.query(
          'SELECT * FROM deuss.bookmark_categories WHERE id = $1 AND user_id = $2',
          [id, userId]
        );

        if (existingCategory.rows.length === 0) {
          return res.status(404).json({ error: 'Category not found' });
        }

        // Update the category
        const result = await pool.query(
          'UPDATE deuss.bookmark_categories SET name = $1, icon = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING *',
          [name, icon || 'wrench', id, userId]
        );

        return res.status(200).json({
          message: 'Category updated successfully',
          category: result.rows[0]
        });
      }
    }

    // Create a new category
    const result = await pool.query(
      'INSERT INTO deuss.bookmark_categories (user_id, name, icon, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
      [userId, name, icon || 'wrench']
    );

    res.status(201).json({
      message: 'Category created successfully',
      category: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating bookmark category:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add a PUT endpoint for updating bookmark categories
app.put('/api/bookmarks/category', loginRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id, name, icon } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'Category ID is required' });
    }

    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    // Check if this is a temporary ID
    if (String(id).length > 10) {
      // Create a new category instead of trying to update a non-existent one
      const result = await pool.query(
        'INSERT INTO deuss.bookmark_categories (user_id, name, icon, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
        [userId, name, icon || 'wrench']
      );

      return res.status(201).json({
        message: 'Category created successfully',
        category: result.rows[0]
      });
    }

    // Verify the category exists and belongs to this user
    const existingCategory = await pool.query(
      'SELECT * FROM deuss.bookmark_categories WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (existingCategory.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found or does not belong to you' });
    }

    // Update the category
    const result = await pool.query(
      'UPDATE deuss.bookmark_categories SET name = $1, icon = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING *',
      [name, icon || 'wrench', id, userId]
    );

    res.status(200).json({
      message: 'Category updated successfully',
      category: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating bookmark category:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a bookmark category
app.delete('/api/bookmarks/category/:id', loginRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const categoryId = parseInt(req.params.id, 10);
    if (isNaN(categoryId)) {
      return res.status(400).json({ 
        error: 'Invalid category ID',
        details: 'Category ID must be a valid integer'
      });
    }

    // Verify the category belongs to the user
    const categoryCheck = await pool.query(
      'SELECT id FROM deuss.bookmark_categories WHERE id = $1 AND user_id = $2',
      [categoryId, userId]
    );

    if (categoryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found or does not belong to user' });
    }

    // Delete the category (and its bookmarks due to ON DELETE CASCADE)
    await pool.query(
      'DELETE FROM deuss.bookmark_categories WHERE id = $1 AND user_id = $2',
      [categoryId, userId]
    );

    res.json({ message: 'Category and all its bookmarks deleted successfully' });

  } catch (error) {
    console.error('Error deleting bookmark category:', error);
    res.status(500).json({ 
      error: 'Failed to delete bookmark category',
      message: error.message
    });
  }
});

// Account Routes
app.post('/api/account', loginRequired, async (req, res) => {
  try {
    // Get user ID from either session or JWT token
    let userId = null;
    
    // Try session first
    if (req.session?.uid) {
      userId = req.session.uid;
    } 
    // Then try JWT user object
    else if (req.user?.id) {
      userId = req.user.id;
    }
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { full_name, email, country } = req.body;
    
    // Validate required fields
    if (!full_name) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    
    // Update user profile
    const result = await pool.query(
      'UPDATE deuss.users SET full_name = $1, country = $2, updated_at = NOW() WHERE id = $3 RETURNING id, email, full_name, country, avatar_url, tier, is_verified',
      [full_name, country || null, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const updatedUser = result.rows[0];
    
    // Format response
    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        full_name: updatedUser.full_name,
        country: updatedUser.country,
        avatar_url: updatedUser.avatar_url,
        tier: updatedUser.tier || 'basic',
        is_verified: updatedUser.is_verified || false,
        initials: getInitials(updatedUser.full_name)
      }
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update profile',
      message: error.message
    });
  }
});

// Function to add default bookmarks for a user
async function addDefaultBookmarksForUser(userId) {
  const client = await pool.connect();
  
  try {
    // Start transaction
    await client.query('BEGIN');
    
    // Get all default categories
    const defaultCategoriesResult = await client.query(
      'SELECT * FROM deuss.default_bookmark_categories'
    );
    
    // For each default category
    for (const defaultCategory of defaultCategoriesResult.rows) {
      // Create category for user
      const categoryResult = await client.query(
        'INSERT INTO deuss.bookmark_categories (user_id, name, icon) VALUES ($1, $2, $3) RETURNING id',
        [userId, defaultCategory.name, defaultCategory.icon]
      );
      
      const categoryId = categoryResult.rows[0].id;
      
      // Get bookmarks for this category
      const bookmarksResult = await client.query(
        'SELECT * FROM deuss.default_bookmarks WHERE category_id = $1',
        [defaultCategory.id]
      );
      
      // Add each bookmark
      for (const bookmark of bookmarksResult.rows) {
        await client.query(
          'INSERT INTO deuss.bookmarks (user_id, category_id, title, url, color, icon) VALUES ($1, $2, $3, $4, $5, $6)',
          [userId, categoryId, bookmark.title, bookmark.url, bookmark.color, bookmark.icon]
        );
      }
    }
    
    // Mark that default bookmarks have been added for this user
    await client.query(
      'UPDATE deuss.users SET default_bookmarks_added = true WHERE id = $1',
      [userId]
    );
    
    // Commit transaction
    await client.query('COMMIT');
    
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    console.error('Error adding default bookmarks for user:', error);
    throw error;
  } finally {
    client.release();
  }
}

app.get('/api/auth/session', async (req, res) => {
  // Check if JWT token is in the Authorization header as fallback
  let userId = null;
  let tokenUser = null;
  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      console.log('Verifying JWT token with secret:', JWT_SECRET);
      console.log('Token being verified:', token.substring(0, 20) + '...');
      tokenUser = jwt.verify(token, JWT_SECRET);
      console.log('Token verified successfully');
      if (tokenUser && tokenUser.id) {
        userId = tokenUser.id;
      }
    } catch (error) {
      console.error('Invalid JWT token in authorization header:', error);
      console.error('JWT_SECRET value:', JWT_SECRET);
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      // Continue to check session anyway
    }
  }
  
  // Then check if there's a session
  let isSessionValid = false;
  if (req.session && req.session.uid) {
    userId = userId || req.session.uid;
    isSessionValid = true;
  }
  
  // If we don't have a user ID from either source, return not authenticated
  if (!userId) {
    return res.status(401).json({ 
      isValid: false, 
      error: 'No valid authentication found',
      sessionExists: !!req.session
    });
  }

  try {
    // Only fetch essential user data
    const result = await pool.query(
      'SELECT id, email, full_name, avatar_url, tier, is_verified FROM deuss.users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      // Check if session exists before destroying it
      if (req.session && typeof req.session.destroy === 'function') {
        req.session.destroy();
      }
      return res.status(404).json({ 
        isValid: false,
        error: 'User not found in database'
      });
    }

    const user = result.rows[0];
    
    // Generate a fresh token to extend authentication
    const newToken = jwt.sign(
      { 
        id: user.id, 
        email: user.email,
        full_name: user.full_name,
        tier: user.tier || 'basic',
        is_verified: user.is_verified || false,
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    // Extend session if it exists and has touch method
    if (req.session) {
      if (typeof req.session.touch === 'function') {
        req.session.touch();
      }
      
      // Ensure user ID is in session
      if (!isSessionValid && !req.session.uid) {
        req.session.uid = userId;
        if (typeof req.session.save === 'function') {
          req.session.save();
        }
      }
    }
    
    // Also set a backup cookie for the JWT
    res.setHeader('Set-Cookie', [
      `jwt=${newToken}; Max-Age=${30 * 24 * 60 * 60}; Path=/; HttpOnly; ${process.env.NODE_ENV === 'production' ? 'Secure; SameSite=None' : ''}`
    ]);
    
    res.json({
      isValid: true,
      sessionValid: isSessionValid,
      sessionID: req.sessionID || null,
      token: newToken,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        tier: user.tier || 'basic',
        is_verified: user.is_verified || false,
        initials: getInitials(user.full_name)
      }
    });
  } catch (error) {
    console.error('Session check error:', error);
    res.status(500).json({ isValid: false });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const result = await pool.query(
      'SELECT id FROM deuss.users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      'UPDATE deuss.users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
      [resetToken, resetTokenExpiry, result.rows[0].id]
    );

    // Send reset password email
    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${resetToken}`;
    
    try {
      // Use Resend's default domain if custom domain is not verified
      const fromEmail = process.env.SMTP_FROM || 'Deuss <onboarding@resend.dev>';

      const { data, error } = await resend.emails.send({
        from: fromEmail,
        to: email,
        subject: 'Reset Your Password',
        html: `
          <div style="font-family: sans-serif; background-color: #1a202c; color: #e2e8f0; padding: 20px;">
            <h1 style="color: #4299e1;">Deuss - Password Reset Request</h1>
            <p>You requested to reset your password. Click the button below to set a new password:</p>
            <p>
              <a href="${resetUrl}" style="display: inline-block; background-color: #2d3748; color: #4299e1; padding: 10px 20px; text-decoration: none; border-radius: 5px; border: 1px solid #4299e1;">
                Reset Password
              </a>
            </p>
            <p>Or copy and paste the following link into your browser:</p>
            <p><code style="color: #e2e8f0; background-color: #2d3748; padding: 5px; border-radius: 3px;">${resetUrl}</code></p>
            <p>This link will expire in 1 hour.</p>
            <p>If you didn't request this, please ignore this email.</p>
          </div>
        `
      });

      if (error) {
        console.error('Error sending reset password email:', error);
        return res.status(500).json({ error: 'Failed to send reset password email' });
      }

      res.json({
        message: 'Password reset instructions sent to your email'
      });
    } catch (emailError) {
      console.error('Error sending reset password email:', emailError);
      res.status(500).json({ error: 'Failed to send reset password email' });
    }
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process forgot password request' });
  }
});

// Add new endpoint for resetting password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  try {
    // Find user with valid reset token
    const result = await pool.query(
      `SELECT id, email, reset_token_expiry 
       FROM deuss.users 
       WHERE reset_token = $1 AND reset_token_expiry > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const user = result.rows[0];

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password and clear reset token
    await pool.query(
      `UPDATE deuss.users 
       SET password = $1, 
           reset_token = NULL, 
           reset_token_expiry = NULL,
           updated_at = NOW()
       WHERE id = $2`,
      [hashedPassword, user.id]
    );

    // Send confirmation email
    const mailOptions = {
      from: {
        name: 'No-Reply',
        address: process.env.SMTP_FROM
      },
      to: user.email,
      subject: 'Password Reset Successful',
      html: `
        <h1>Password Reset Successful</h1>
        <p>Your password has been successfully reset.</p>
        <p>If you didn't make this change, please contact support immediately.</p>
      `
    };

    try {
      await transporter.sendMail(mailOptions);
    } catch (emailError) {
      console.error('Error sending password reset confirmation email:', emailError);
      // Don't fail the request if email fails
    }

    res.json({ message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Notes Routes
app.get('/api/notes', async (req, res) => {
  // Handle both session auth and JWT auth
  let userId;
  
  // Get userId from session if available
  if (req.session?.uid) {
    userId = req.session.uid;
  }
  // If not in session, try from JWT token
  else if (req.user?.id) {
    userId = req.user.id;
  }
  // Check Authorization header directly as a last resort
  else {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.id) {
          userId = decoded.id;
        }
      } catch (error) {
        console.error('JWT verification failed in notes route:', error);
      }
    }
  }
  
  // If we still don't have a userId, user is not authenticated
  if (!userId) {
    return res.status(401).json({ 
      error: 'User not authenticated',
      notes: [] // Return empty array instead of error for more graceful frontend handling
    });
  }
  
  try {
    const result = await pool.query(
      'SELECT * FROM deuss.notes WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId]
    );
    
    res.json({ notes: result.rows });
  } catch (error) {
    console.error('Error fetching notes:', error);
    // Return empty array instead of error for more resilient frontend behavior
    res.status(500).json({ 
      error: 'Failed to fetch notes',
      notes: []
    });
  }
});

app.post('/api/notes', loginRequired, async (req, res) => {
  // Get user ID from either session or JWT token
  let userId = null;
  
  // Try session first
  if (req.session?.uid) {
    userId = req.session.uid;
  } 
  // Then try JWT user object
  else if (req.user?.id) {
    userId = req.user.id;
  }
  
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  const { content, id, title, tags } = req.body;
  
  if (content === undefined) {
    return res.status(400).json({ error: 'Note content is required' });
  }
  
  try {
    if (id) {
      // Update existing note
      await pool.query(
        'UPDATE deuss.notes SET content = $1, title = $2, updated_at = NOW(), tags = $3 WHERE id = $4 AND user_id = $5',
        [content, title || '', tags || [], id, userId]
      );
      
      res.json({ 
        message: 'Note updated successfully',
        noteId: id
      });
    } else {
      // Create new note
      const result = await pool.query(
        'INSERT INTO deuss.notes (user_id, content, title, tags, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id',
        [userId, content, title || '', tags || []]
      );
      
      res.json({ 
        message: 'Note created successfully',
        noteId: result.rows[0].id
      });
    }
  } catch (error) {
    console.error('Error saving note:', error);
    res.status(500).json({ error: 'Failed to save note' });
  }
});

app.delete('/api/notes/:id', loginRequired, async (req, res) => {
  const userId = req.session?.uid;
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  const noteId = req.params.id;
  
  try {
    const result = await pool.query(
      'DELETE FROM deuss.notes WHERE id = $1 AND user_id = $2 RETURNING id',
      [noteId, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    res.json({ message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Hacking Profiles Routes
app.get('/api/hacking-profiles', loginRequired, async (req, res) => {
  // Get user ID from either session or JWT token
  let userId = null;
  
  // Try session first
  if (req.session?.uid) {
    userId = req.session.uid;
  } 
  // Then try JWT user object
  else if (req.user?.id) {
    userId = req.user.id;
  }
  
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  try {
    const result = await pool.query(
      'SELECT * FROM deuss.hacking_profiles WHERE user_id = $1',
      [userId]
    );
    
    res.json({ profiles: result.rows });
  } catch (error) {
    console.error('Error fetching hacking profiles:', error);
    res.status(500).json({ error: 'Failed to fetch hacking profiles' });
  }
});

app.post('/api/connect-platform', loginRequired, async (req, res) => {
  // Get user ID from either session or JWT token
  let userId = null;
  
  // Try session first
  if (req.session?.uid) {
    userId = req.session.uid;
  } 
  // Then try JWT user object
  else if (req.user?.id) {
    userId = req.user.id;
  }
  
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  const { platform, username, apiKey } = req.body;
  
  if (!platform || !username) {
    return res.status(400).json({ error: 'Platform and username are required' });
  }
  
  try {
    // For TryHackMe, ensure apiKey is null
    const profileApiKey = platform === 'tryhackme' ? null : apiKey;
    
    const result = await pool.query(
      `INSERT INTO deuss.hacking_profiles (user_id, platform, username, api_key, connected, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       ON CONFLICT (user_id, platform) 
       DO UPDATE SET 
         username = $3,
         api_key = $4,
         connected = true,
         updated_at = NOW()
       RETURNING *`,
      [userId, platform, username, profileApiKey]
    );
    
    res.json({ 
      message: `Connected to ${platform}`,
      platform: result.rows[0]
    });
  } catch (error) {
    console.error('Error connecting platform:', error);
    res.status(500).json({ error: 'Failed to connect platform' });
  }
});

app.post('/api/disconnect-platform', loginRequired, async (req, res) => {
  // Get user ID from either session or JWT token
  let userId = null;
  
  // Try session first
  if (req.session?.uid) {
    userId = req.session.uid;
  } 
  // Then try JWT user object
  else if (req.user?.id) {
    userId = req.user.id;
  }
  
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  const { platform } = req.body;
  
  if (!platform) {
    return res.status(400).json({ error: 'Platform is required' });
  }
  
  try {
    const result = await pool.query(
      'UPDATE deuss.hacking_profiles SET connected = false, updated_at = NOW() WHERE user_id = $1 AND platform = $2 RETURNING *',
      [userId, platform]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Platform not found' });
    }
    
    res.json({ 
      message: `Disconnected from ${platform}`,
      platform: result.rows[0]
    });
  } catch (error) {
    console.error('Error disconnecting platform:', error);
    res.status(500).json({ error: 'Failed to disconnect platform' });
  }
});

// Social Profiles Routes
app.get('/api/social-profiles', loginRequired, async (req, res) => {
  // Get user ID from either session or JWT token
  let userId = null;
  
  // Try session first
  if (req.session?.uid) {
    userId = req.session.uid;
  } 
  // Then try JWT user object
  else if (req.user?.id) {
    userId = req.user.id;
  }
  
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  try {
    const result = await pool.query(
      'SELECT * FROM deuss.social_profiles WHERE user_id = $1',
      [userId]
    );
    
    res.json({ profiles: result.rows });
  } catch (error) {
    console.error('Error fetching social profiles:', error);
    res.status(500).json({ error: 'Failed to fetch social profiles' });
  }
});

app.post('/api/connect-social', loginRequired, async (req, res) => {
  // Get user ID from either session or JWT token
  let userId = null;
  
  // Try session first
  if (req.session?.uid) {
    userId = req.session.uid;
  } 
  // Then try JWT user object
  else if (req.user?.id) {
    userId = req.user.id;
  }
  
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  const { platform, username, apiKey } = req.body;
  
  if (!platform || !username) {
    return res.status(400).json({ error: 'Platform and username are required' });
  }
  
  // Special handling for Twitter/X - validate API key requirement
  if ((platform === 'twitter' || platform === 'x') && !apiKey) {
    return res.status(400).json({ 
      error: 'API key is required for Twitter/X integration',
      message: 'Please provide a Twitter API bearer token to connect your profile'
    });
  }
  
  // Set URL based on platform
  let url = "";
  switch (platform) {
    case "github":
      url = "https://github.com/";
      break;
    case "twitter":
    case "x":
      url = "https://twitter.com/";
      break;
    case "linkedin":
      url = "https://linkedin.com/in/";
      break;
    case "youtube":
      url = "https://youtube.com/@";
      break;
    default:
      url = "";
  }
  
  try {
    // Normalize the platform name (convert 'x' to 'twitter')
    const normalizedPlatform = platform === 'x' ? 'twitter' : platform;
    
    // Log API key information for debugging
    if (apiKey) {
      // API key provided
    } else {
      // No API key provided
    }
    
    const result = await pool.query(
      `INSERT INTO deuss.social_profiles (user_id, platform, username, url, api_key, connected, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
       ON CONFLICT (user_id, platform) 
       DO UPDATE SET 
         username = $3,
         url = $4,
         api_key = $5,
         connected = true,
         updated_at = NOW()
       RETURNING *`,
      [userId, normalizedPlatform, username, url, apiKey]
    );
    
    // For Twitter, immediately test the API key to provide feedback
    if (normalizedPlatform === 'twitter' && apiKey) {
      try {
        // Attempt to validate the Twitter API key by making a simple request
        const axios = require('axios');
        const cleanUsername = username.startsWith('@') ? username.substring(1) : username;
        
        await axios.get(
          `https://api.twitter.com/2/users/by/username/${cleanUsername}?user.fields=public_metrics`, 
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`
            }
          }
        );
        
        res.json({ 
          message: `Connected to ${normalizedPlatform}`,
          platform: result.rows[0],
          status: 'connected'
        });
      } catch (apiError) {
        console.error(`Failed to validate Twitter API key:`, apiError.response?.status || apiError.message);
        
        // Still save the profile data, but return an error message about the API key
        return res.status(200).json({ 
          message: `Connected to ${normalizedPlatform} but API key may be invalid`,
          platform: result.rows[0],
          status: 'connected_with_warning',
          warning: 'The provided Twitter API key may be invalid or have insufficient permissions'
        });
      }
    } else {
      res.json({ 
        message: `Connected to ${normalizedPlatform}`,
        platform: result.rows[0],
        status: 'connected'
      });
    }
  } catch (error) {
    console.error('Error connecting social profile:', error);
    res.status(500).json({ error: 'Failed to connect social profile' });
  }
});

app.post('/api/disconnect-social', loginRequired, async (req, res) => {
  // Get user ID from either session or JWT token
  let userId = null;
  
  // Try session first
  if (req.session?.uid) {
    userId = req.session.uid;
  } 
  // Then try JWT user object
  else if (req.user?.id) {
    userId = req.user.id;
  }
  
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  
  const { platform } = req.body;
  
  if (!platform) {
    return res.status(400).json({ error: 'Platform is required' });
  }
  
  try {
    const result = await pool.query(
      'UPDATE deuss.social_profiles SET connected = false, updated_at = NOW() WHERE user_id = $1 AND platform = $2 RETURNING *',
      [userId, platform]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Platform not found' });
    }
    
    res.json({ 
      message: `Disconnected from ${platform}`,
      platform: result.rows[0]
    });
  } catch (error) {
    console.error('Error disconnecting social profile:', error);
    res.status(500).json({ error: 'Failed to disconnect social profile' });
  }
});

// TryHackMe API Routes
app.get('/api/tryhackme/rank/:username', async (req, res) => {
  const { username } = req.params;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  try {
    const axios = require('axios');
    const response = await axios.get(`https://tryhackme.com/api/user/rank/${username}`);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching TryHackMe rank:', error);
    res.status(500).json({ 
      error: 'Failed to fetch TryHackMe rank',
      details: error.message 
    });
  }
});

app.get('/api/tryhackme/badges/:username', async (req, res) => {
  const { username } = req.params;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  try {
    const axios = require('axios');
    const response = await axios.get(`https://tryhackme.com/api/badges/get/${username}`);
    res.json({
      badges: response.data,
      count: response.data.length
    });
  } catch (error) {
    console.error('Error fetching TryHackMe badges:', error);
    res.status(500).json({ 
      error: 'Failed to fetch TryHackMe badges',
      details: error.message 
    });
  }
});

app.get('/api/tryhackme/rooms/:username', async (req, res) => {
  const { username } = req.params;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  try {
    const axios = require('axios');
    const response = await axios.get(`https://tryhackme.com/api/no-completed-rooms-public/${username}`);
    res.json({
      completedRooms: parseInt(response.data, 10) || 0
    });
  } catch (error) {
    console.error('Error fetching TryHackMe completed rooms:', error);
    res.status(500).json({ 
      error: 'Failed to fetch TryHackMe completed rooms',
      details: error.message 
    });
  }
});

// Add new endpoint for TryHackMe Discord API
app.get('/api/tryhackme/user/:username', async (req, res) => {
  const { username } = req.params;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  try {
    const axios = require('axios');
    const response = await axios.get(`https://tryhackme.com/api/discord/user/${username}`);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching TryHackMe user data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch TryHackMe user data',
      details: error.message 
    });
  }
});

// Add new endpoint for TryHackMe tickets won
app.get('/api/tryhackme/tickets/:username', async (req, res) => {
  const { username } = req.params;
  
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  try {
    const axios = require('axios');
    const response = await axios.get(`https://tryhackme.com/games/tickets/won?username=${username}`);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching TryHackMe tickets:', error);
    res.status(500).json({ 
      error: 'Failed to fetch TryHackMe tickets',
      details: error.message 
    });
  }
});

// Simple in-memory cache for Twitter responses
const twitterCache = {
  profiles: new Map(),
  tweets: new Map()
};

// Cache expiry times (in milliseconds)
const PROFILE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes for profiles
const TWEETS_CACHE_TTL = 5 * 60 * 1000;   // 5 minutes for tweets

// Mock tweets generator for fallback
function generateMockTweets() {
  return [
    {
      id: 'mock1',
      text: 'Sorry, Twitter API rate limit exceeded. This is a mock tweet to show the UI.',
      created_at: new Date().toISOString(),
      public_metrics: {
        retweet_count: 0,
        reply_count: 0,
        like_count: 0,
        quote_count: 0
      }
    },
    {
      id: 'mock2',
      text: 'Please try again later. Twitter limits API requests.',
      created_at: new Date(Date.now() - 86400000).toISOString(),
      public_metrics: {
        retweet_count: 0,
        reply_count: 0,
        like_count: 0,
        quote_count: 0
      }
    }
  ];
}

// Helper function to get Twitter API key for a username
async function getTwitterApiKey(username) {
  try {
    // Clean up username format
    let cleanUsername = username.trim();
    if (cleanUsername.startsWith('@')) {
      cleanUsername = cleanUsername.substring(1);
    }
    
    // First try: Look up by provided username directly
    const profileByUsernameResult = await pool.query(
      'SELECT api_key FROM deuss.social_profiles WHERE platform = $1 AND username = $2 AND connected = true',
      ['twitter', cleanUsername]
    );
    
    if (profileByUsernameResult.rows.length > 0 && profileByUsernameResult.rows[0].api_key) {
      return profileByUsernameResult.rows[0].api_key;
    }
    
    // Fall back to environment variable if no user API key
    if (process.env.TWITTER_BEARER_TOKEN) {
      return process.env.TWITTER_BEARER_TOKEN;
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching Twitter API key:', error);
    return null;
  }
}

// Helper function to check if a Twitter user is verified
async function isTwitterUserVerified(username, apiKey) {
  try {
    // Check cache first
    const cacheKey = username.toLowerCase();
    const cachedProfile = twitterCache.profiles.get(cacheKey);
    if (cachedProfile && cachedProfile.timestamp > Date.now() - PROFILE_CACHE_TTL) {
      return cachedProfile.data.verified || false;
    }

    // If not in cache, fetch from API
    const userResponse = await fetch(
      `https://api.twitter.com/2/users/by/username/${username}?user.fields=verified`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!userResponse.ok) {
      return false;
    }

    const userData = await userResponse.json();
    return userData.data.verified || false;
  } catch (error) {
    console.error('Error checking if Twitter user is verified:', error);
    return false;
  }
}

// Twitter API endpoints
app.get('/api/twitter-profile', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ error: 'Missing username parameter' });
    }

    // Check cache first
    const cacheKey = username.toLowerCase();
    const cachedProfile = twitterCache.profiles.get(cacheKey);
    if (cachedProfile && cachedProfile.timestamp > Date.now() - PROFILE_CACHE_TTL) {
      return res.json(cachedProfile.data);
    }

    // Get API key from database
    const apiKey = await getTwitterApiKey(username);
    if (!apiKey) {
      return res.status(404).json({ error: 'Twitter API key not found for this user' });
    }

    // Make request to Twitter API
    const twitterResponse = await fetch(
      `https://api.twitter.com/2/users/by/username/${username}?user.fields=description,profile_image_url,public_metrics,verified`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    // Handle different response statuses
    if (twitterResponse.status === 401) {
      return res.status(401).json({ 
        error: 'Invalid Twitter credentials', 
        message: 'The Twitter API key is invalid or expired.' 
      });
    }
    
    if (twitterResponse.status === 429) {
      // If we have a cached version (even if expired), return it
      if (cachedProfile) {
        return res.status(200).json(cachedProfile.data);
      }
      
      return res.status(429).json({ 
        error: 'Twitter API rate limit exceeded', 
        message: 'Please try again later.' 
      });
    }

    if (twitterResponse.status === 404) {
      return res.status(404).json({ 
        error: 'Twitter user not found', 
        message: `No Twitter profile found for username: ${username}` 
      });
    }

    if (!twitterResponse.ok) {
      const errorData = await twitterResponse.json();
      console.error('Twitter API error:', errorData);
      return res.status(twitterResponse.status).json({ 
        error: 'Twitter API error', 
        message: errorData.detail || 'An error occurred while fetching Twitter data' 
      });
    }

    const twitterData = await twitterResponse.json();
    
    // Cache the successful response
    twitterCache.profiles.set(cacheKey, {
      data: twitterData.data,
      timestamp: Date.now()
    });
    
    res.json(twitterData.data);
  } catch (error) {
    console.error('Twitter profile fetch error:', error);
    res.status(500).json({ error: 'Server error', message: error.message });
  }
});

app.get('/api/twitter-tweets', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ error: 'Missing username parameter' });
    }

    // Check cache first
    const cacheKey = username.toLowerCase();
    const cachedTweets = twitterCache.tweets.get(cacheKey);
    if (cachedTweets && cachedTweets.timestamp > Date.now() - TWEETS_CACHE_TTL) {
      return res.json(cachedTweets.data);
    }

    // Get API key from database
    const apiKey = await getTwitterApiKey(username);
    if (!apiKey) {
      return res.status(404).json({ error: 'Twitter API key not found for this user' });
    }

    // Get user ID first
    const userResponse = await fetch(
      `https://api.twitter.com/2/users/by/username/${username}?user.fields=verified,public_metrics`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    // Handle user lookup errors
    if (userResponse.status === 429) {
      // If we have a cached version (even if expired), return it
      if (cachedTweets) {
        return res.json(cachedTweets.data);
      }
      
      // Check if the user is verified before returning mock tweets
      const isVerified = await isTwitterUserVerified(username, apiKey);
      if (isVerified) {
        return res.status(429).json({ 
          error: 'Twitter API rate limit exceeded', 
          message: 'Rate limit exceeded for verified user, please try again later.',
          verified: true
        });
      }
      
      // Return mock tweets as fallback for non-verified users
      const mockResponse = {
        data: generateMockTweets(),
        meta: {
          result_count: 2,
          newest_id: 'mock1',
          oldest_id: 'mock2'
        },
        fallback: true,
        error: 'Twitter API rate limit exceeded',
        message: 'Using mock data due to rate limiting'
      };
      
      return res.status(200).json(mockResponse);
    }

    if (!userResponse.ok) {
      const errorData = await userResponse.json();
      return res.status(userResponse.status).json({ 
        error: 'Twitter API error', 
        message: errorData.detail || 'Error fetching Twitter user data' 
      });
    }

    const userData = await userResponse.json();
    const userId = userData.data.id;
    const isVerified = userData.data.verified || false;
    
    // Check if user has 0 tweets
    if (userData.data.public_metrics && userData.data.public_metrics.tweet_count === 0) {
      const emptyResponse = {
        data: [],
        meta: {
          result_count: 0
        }
      };
      
      // Cache the empty response
      twitterCache.tweets.set(cacheKey, {
        data: emptyResponse,
        timestamp: Date.now()
      });
      
      return res.json(emptyResponse);
    }

    // Now fetch the tweets
    const tweetsResponse = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?max_results=5&tweet.fields=created_at,public_metrics&exclude=retweets,replies`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    // Handle tweets lookup errors
    if (tweetsResponse.status === 429) {
      // If we have a cached version (even if expired), return it
      if (cachedTweets) {
        return res.json(cachedTweets.data);
      }
      
      // For verified users, don't return mock tweets
      if (isVerified) {
        return res.status(429).json({ 
          error: 'Twitter API rate limit exceeded', 
          message: 'Rate limit exceeded for verified user, please try again later.',
          verified: true
        });
      }
      
      // Return mock tweets as fallback for non-verified users
      const mockResponse = {
        data: generateMockTweets(),
        meta: {
          result_count: 2,
          newest_id: 'mock1',
          oldest_id: 'mock2'
        },
        fallback: true,
        error: 'Twitter API rate limit exceeded',
        message: 'Using mock data due to rate limiting'
      };
      
      return res.status(200).json(mockResponse);
    }

    if (!tweetsResponse.ok) {
      const errorData = await tweetsResponse.json();
      return res.status(tweetsResponse.status).json({ 
        error: 'Twitter API error', 
        message: errorData.detail || 'Error fetching tweets' 
      });
    }

    const tweetsData = await tweetsResponse.json();
    
    // Cache the successful response
    twitterCache.tweets.set(cacheKey, {
      data: tweetsData,
      timestamp: Date.now()
    });
    
    res.json(tweetsData);
  } catch (error) {
    console.error('Twitter tweets fetch error:', error);
    res.status(500).json({ error: 'Server error', message: error.message });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  // Handle specific PostgreSQL errors
  if (err.code) {
    switch (err.code) {
      case '42P01': // undefined_table
        console.warn('Table not found error:', err.message);
        if (err.message.includes('deuss.deuss.session')) {
          console.error('Session table name is incorrectly double-qualified. Check session store configuration.');
        }
        return next(); // Continue processing the request
        
      case '42P07': // duplicate_table
        console.warn('Ignoring duplicate table error:', err.message);
        return next(); // Continue processing the request
      
      case '23505': // unique_violation
        if (err.message && err.message.includes('session_pkey')) {
          console.warn('Ignoring session primary key conflict');
          return next();
        }
        break;
        
      case 'ETIMEDOUT':
      case 'ECONNREFUSED':
      case 'ENOTFOUND':
        console.error('Database connection error:', err);
        return res.status(503).json({
          error: 'Database service temporarily unavailable',
          status: 'error'
        });
    }
  }
  
  console.error('Unhandled error:', err);
  
  // Don't expose error details in production
  const errorMessage = process.env.NODE_ENV === 'production' 
    ? 'An unexpected error occurred' 
    : err.message;
  
  // Determine appropriate status code
  const statusCode = err.statusCode || 500;
  
  res.status(statusCode).json({ 
    error: errorMessage,
    status: 'error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Export app for testing
module.exports = { app };

// Start server
app.listen(PORT, () => {
  console.log(`Core api running on ${PORT}`);
});

// Add debugging middleware to check session on each request
app.use((req, res, next) => {
  // Only log if debugging is enabled
  if (process.env.DEBUG_SESSION === 'true') {
    // Session ID
    // Session data
  }
  next();
});
