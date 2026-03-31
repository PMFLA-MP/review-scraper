const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Search Google Places — returns up to 60 businesses with reviews
app.post('/api/search', async (req, res) => {
  const { bizType, location } = req.body;

  if (!bizType || !location) {
    return res.status(400).json({ error: 'Business type and location are required.' });
  }

  const query = `${bizType} in ${location}`;
  let businesses = [];
  let pageToken = null;
  let pages = 0;

  try {
    do {
      const url = pageToken
        ? `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${pageToken}&key=${GOOGLE_KEY}`
        : `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_KEY}`;

      const searchRes = await fetch(url);
      const searchData = await searchRes.json();

      if (searchData.status === 'ZERO_RESULTS') break;

      if (searchData.status !== 'OK') {
        return res.status(500).json({ error: `Google Places error: ${searchData.status}` });
      }

      // Fetch details (including reviews) for each business in parallel
      const detailPromises = (searchData.results || []).map(async (place) => {
        const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,formatted_address,rating,reviews&key=${GOOGLE_KEY}`;
        const detailRes = await fetch(detailUrl);
        const detailData = await detailRes.json();
        const d = detailData.result || {};
        return {
          name: d.name || place.name,
          phone: d.formatted_phone_number || 'N/A',
          address: d.formatted_address || place.formatted_address || 'N/A',
          rating: d.rating || place.rating || 0,
          reviews: (d.reviews || []).map(r => r.text).filter(Boolean)
        };
      });

      const pageResults = await Promise.all(detailPromises);
      businesses = businesses.concat(pageResults);

      pageToken = searchData.next_page_token;
      pages++;

      // Google requires a short delay before next_page_token becomes valid
      if (pageToken && pages < 3) {
        await new Promise(r => setTimeout(r, 2000));
      }

    } while (pageToken && pages < 3);

    res.json({ businesses, total: businesses.length });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Failed to fetch businesses. Check your Google API key.' });
  }
});

// Analyze a single business's reviews with Claude
app.post('/api/analyze', async (req, res) => {
  const { business } = req.body;

  if (!business.reviews || business.reviews.length === 0) {
    return res.json({ flagged: false, priority: 'None', painPoint: '', triggerQuote: '' });
  }

  const reviewText = business.reviews.map((r, i) => `Review ${i + 1}: "${r}"`).join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You analyze business reviews to find payment processing pain points for a merchant services sales team.

Business: ${business.name}
Reviews:
${reviewText}

Scan for: processing fees, credit card fees, surcharge, POS system problems, card reader issues, terminal crashes, slow checkout, cash only, no Amex, chargebacks, equipment issues, high transaction fees.

Respond ONLY with valid JSON, no markdown:
{"flagged":true or false,"priority":"High" or "Medium" or "Low" or "None","painPoint":"one sentence summary or empty string","triggerQuote":"exact short phrase under 15 words from a review that triggered the flag, or empty string"}

Priority: High=explicit fee % complaints or POS crashes causing lost sales. Medium=cash-only policy, no Amex, equipment down. Low=vague or minor mention. None=no issues found.`
        }]
      })
    });

    const data = await response.json();
    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(text));

  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: 'Failed to analyze reviews.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Review Scraper running on port ${PORT}`));
