import http from 'k6/http';
import { check } from 'k6';

// Read-only benchmark: no records, no settings, no uploads, no auth writes.
export const options = {
  vus: 20,
  duration: '30s',
  thresholds: {
    'http_req_duration{name:health}': ['p(95)<200'],
    'http_req_duration{name:status}': ['p(95)<200'],
  },
};

const BASE = __ENV.BASE;

export default function () {
  const health = http.get(`${BASE}/api/health`, { tags: { name: 'health' } });
  check(health, { 'health 200': (r) => r.status === 200 });

  const status = http.get(`${BASE}/api/auth/status`, { tags: { name: 'status' } });
  check(status, { 'status 200': (r) => r.status === 200 });

  const page = http.get(`${BASE}/`, { tags: { name: 'html' } });
  check(page, { 'html 200': (r) => r.status === 200 });
}
