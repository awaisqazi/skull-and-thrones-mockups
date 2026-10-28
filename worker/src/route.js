/**
 * Which GitHub repository_dispatch event a Square webhook type should fire.
 *  - booking.*                      -> 'square-booking'  (availability.yml refreshes the chips)
 *  - catalog.version.updated,
 *    team_member.*, location.updated -> 'square-catalog'  (deploy.yml rebuilds the site)
 *  - anything else                  -> null (answer 200, do nothing)
 */
export const BOOKING_EVENT = 'square-booking';
export const CATALOG_EVENT = 'square-catalog';

export function routeEvent(type) {
  if (typeof type !== 'string') return null;
  if (type.startsWith('booking.')) return BOOKING_EVENT;
  if (type === 'catalog.version.updated' || type.startsWith('team_member.') || type === 'location.updated') return CATALOG_EVENT;
  return null;
}
