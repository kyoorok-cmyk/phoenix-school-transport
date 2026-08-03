# Phoenix School Transport Management

Multi-tenant SaaS platform for South African school transport operators.

## Architecture

- **Backend**: Supabase (PostgreSQL + Edge Functions + Realtime + Auth)
- **Operator Portal**: Electron desktop app (TypeScript + vanilla JS + Leaflet)
- **Driver App**: Flutter mobile app (Dart + BLoC + sqflite)
- **Admin Portal**: Preact web app (TypeScript + Vite)

## Getting Started

1. Set up Supabase project and apply migrations
2. Copy `.env.example` to `.env` and fill in your Supabase credentials
3. Run Edge Functions: `supabase functions serve`
4. Desktop app: `cd desktop-app && npm install && npm test`

## Testing

```bash
cd desktop-app
npm install
npm test           # Run all tests
npm run test:properties  # Run property-based tests only
```

## Project Structure

- `supabase/migrations/` - Database schema
- `supabase/functions/` - 16 Supabase Edge Functions
- `desktop-app/` - Electron Operator Portal
- `driver-app/` - Flutter Driver App
- `admin-portal/` - Preact Admin Portal
