DROP TRIGGER IF EXISTS trg_audit_transport_vehicles ON transport_vehicles;
DROP TRIGGER IF EXISTS trg_audit_transport_routes ON transport_routes;
DROP TRIGGER IF EXISTS trg_audit_transport_stops ON transport_stops;
DROP TRIGGER IF EXISTS trg_audit_transport_students ON transport_students;
DROP TRIGGER IF EXISTS trg_audit_transport_schedules ON transport_schedules;
DROP TRIGGER IF EXISTS trg_audit_transport_trips ON transport_trips;
ALTER TABLE transport_audit_log DISABLE ROW LEVEL SECURITY;
