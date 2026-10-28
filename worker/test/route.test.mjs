import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeEvent } from '../src/route.js';

test('booking.* fires square-booking', () => {
  for (const t of ['booking.created', 'booking.updated', 'booking.something.new']) assert.equal(routeEvent(t), 'square-booking', t);
});

test('catalog, team member and location events fire square-catalog', () => {
  for (const t of ['catalog.version.updated', 'team_member.created', 'team_member.updated', 'location.updated']) assert.equal(routeEvent(t), 'square-catalog', t);
});

test('everything else is ignored', () => {
  for (const t of ['payment.created', 'order.updated', 'location.created', 'catalog.version', 'bookings.created', 'Booking.created', '', undefined, null, 5, {}]) {
    assert.equal(routeEvent(t), null, String(t));
  }
});
