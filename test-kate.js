// One-shot test: submit Kate's Bait & Sporting Goods report and exit.
const session = 'test-kate-' + Date.now();

fetch('http://localhost:3000/classify', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie': 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjEsImlhdCI6MTc3OTkwMTQwNCwiZXhwIjoxNzgwNTA2MjA0fQ.3sZxN5vecqnfo1AY594FF7Q_Liw-QfJ8ZIvjOHsvZwM'
  },
  body: JSON.stringify({
    query: "Kate's Bait & Sporting Goods, 3916 WI-23, Dodgeville, WI 53533, USA",
    place_id: 'ChIJ7Uwftk9l_YcR9paI7Gtc41U',
    sessionId: session
  })
})
  .then((r) => r.json())
  .then((d) => {
    console.log('RESPONSE:', JSON.stringify(d));
    console.log('SESSION:', session);
  })
  .catch((e) => console.error('FETCH ERROR:', e.message));
