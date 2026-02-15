const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
const PROXY_SECRET = process.env.PROXY_SECRET;

// Authentication middleware
app.use((req, res, next) => {
  // Skip auth for health check
  if (req.path === '/health') {
    return next();
  }
  
  // Check for authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: { 
        message: 'Unauthorized: Missing API key',
        type: 'authentication_error' 
      } 
    });
  }
  
  // Verify the secret
  const providedKey = authHeader.replace('Bearer ', '');
  if (providedKey !== PROXY_SECRET) {
    return res.status(401).json({ 
      error: { 
        message: 'Unauthorized: Invalid API key',
        type: 'authentication_error' 
      } 
    });
  }
  
  next();
});

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy',
    authenticated: true
  });
});

// List models endpoint
app.get('/v1/models', (req, res) => {
  const models = [
    { id: 'gpt-4o', object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy' },
    { id: 'gpt-4', object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy' }
  ];
  res.json({ object: 'list', data: models });
});

// Chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Use GLM-4.7 model
    const nimModel = 'z-ai/glm4.7';
    
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.7,
      max_tokens: max_tokens || 2048,
      stream: stream || false
    };
    
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
    } else {
      // Handle response and reasoning content
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let content = choice.message?.content || '';
          
          // If there's reasoning content, include it
          if (choice.message?.reasoning_content) {
            content = choice.message.reasoning_content + (content ? '\n\n' + content : '');
          }
          
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: content
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || { 
          prompt_tokens: 0, 
          completion_tokens: 0, 
          total_tokens: 0 
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.error?.message || error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Authentication: ${PROXY_SECRET ? 'ENABLED' : 'DISABLED'}`);
});
