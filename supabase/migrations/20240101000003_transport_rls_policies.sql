-- Migration: Row-Level Security policies for all transport tables
-- Implements tenant isolation, role-based access, and driver-specific policies
-- Part of: Phoenix School Transport Management
-- Requirements: 1.3 (tenant isolation), 2.5 (role-based access denial), 13.4 (vendor admin)

-- =============================================================================
-- ENABLE RLS ON ALL TRANSPORT TABLES
-- =============================================================================
ALTER TABLE transport_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_student_guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_trip_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_school_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_audit_log ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- TENANT ISOLATION POLICIES (all tables)
-- Ensures each tenant can only access their own data
-- Requirement 1.3: Tenant data isolation through RLS
-- =============================================================================
CREATE POLICY tenant_isolation ON transport_vehicles
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_routes
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_stops
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_students
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_guardians
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_student_guardians
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM transport_students s
            WHERE s.id = transport_student_guardians.student_id
            AND s.tenant_id = public.get_tenant_id()
        )
    );

CREATE POLICY tenant_isolation ON transport_schedules
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_trips
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_attendance
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_trip_locations
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_invoices
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_payments
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_notifications
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_whatsapp_messages
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_school_closures
    FOR ALL USING (tenant_id = public.get_tenant_id());

CREATE POLICY tenant_isolation ON transport_audit_log
    FOR ALL USING (tenant_id = public.get_tenant_id());

-- =============================================================================
-- DRIVER-SPECIFIC POLICIES
-- Requirement 2.5: Role-based access control
-- =============================================================================

-- Drivers can only see trips assigned to them; operators and admins see all
CREATE POLICY driver_own_trips ON transport_trips
    FOR SELECT USING (
        driver_id = auth.uid()
        OR public.get_user_role() IN ('operator', 'admin')
    );

-- Drivers can INSERT attendance records (record student board/absent)
CREATE POLICY driver_record_attendance ON transport_attendance
    FOR INSERT WITH CHECK (
        public.get_user_role() IN ('driver', 'operator', 'admin')
    );

-- Drivers can SELECT attendance for their own trips
CREATE POLICY driver_view_attendance ON transport_attendance
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM transport_trips t
            WHERE t.id = transport_attendance.trip_id
            AND (t.driver_id = auth.uid() OR public.get_user_role() IN ('operator', 'admin'))
        )
    );

-- Operators and admins can UPDATE/DELETE attendance
CREATE POLICY operator_manage_attendance ON transport_attendance
    FOR UPDATE USING (
        public.get_user_role() IN ('operator', 'admin')
    );

CREATE POLICY operator_delete_attendance ON transport_attendance
    FOR DELETE USING (
        public.get_user_role() IN ('operator', 'admin')
    );

-- Drivers can INSERT GPS location data
CREATE POLICY driver_insert_locations ON transport_trip_locations
    FOR INSERT WITH CHECK (
        public.get_user_role() IN ('driver', 'operator', 'admin')
    );

-- Operators and admins can SELECT GPS location data
CREATE POLICY operator_view_locations ON transport_trip_locations
    FOR SELECT USING (
        public.get_user_role() IN ('operator', 'admin')
        OR EXISTS (
            SELECT 1 FROM transport_trips t
            WHERE t.id = transport_trip_locations.trip_id
            AND t.driver_id = auth.uid()
        )
    );

-- =============================================================================
-- WRITE ACCESS POLICIES FOR MANAGEMENT TABLES
-- Only operators and admins can INSERT/UPDATE/DELETE on management tables
-- Requirement 2.5: Role-based access restriction
-- =============================================================================

-- transport_vehicles: write restricted to operator/admin
CREATE POLICY operator_manage_vehicles ON transport_vehicles
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_vehicles ON transport_vehicles
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_vehicles ON transport_vehicles
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_routes: write restricted to operator/admin
CREATE POLICY operator_manage_routes ON transport_routes
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_routes ON transport_routes
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_routes ON transport_routes
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_stops: write restricted to operator/admin
CREATE POLICY operator_manage_stops ON transport_stops
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_stops ON transport_stops
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_stops ON transport_stops
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_students: write restricted to operator/admin
CREATE POLICY operator_manage_students ON transport_students
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_students ON transport_students
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_students ON transport_students
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_guardians: write restricted to operator/admin
CREATE POLICY operator_manage_guardians ON transport_guardians
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_guardians ON transport_guardians
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_guardians ON transport_guardians
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_student_guardians: write restricted to operator/admin
CREATE POLICY operator_manage_student_guardians ON transport_student_guardians
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_student_guardians ON transport_student_guardians
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_student_guardians ON transport_student_guardians
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_schedules: write restricted to operator/admin
CREATE POLICY operator_manage_schedules ON transport_schedules
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_schedules ON transport_schedules
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_schedules ON transport_schedules
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_trips: write restricted to operator/admin (drivers use Edge Functions)
CREATE POLICY operator_manage_trips ON transport_trips
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_trips ON transport_trips
    FOR UPDATE USING (
        public.get_user_role() IN ('operator', 'admin')
        OR (public.get_user_role() = 'driver' AND driver_id = auth.uid())
    );

CREATE POLICY operator_delete_trips ON transport_trips
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_invoices: write restricted to operator/admin
CREATE POLICY operator_manage_invoices ON transport_invoices
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_invoices ON transport_invoices
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_invoices ON transport_invoices
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_payments: write restricted to operator/admin
CREATE POLICY operator_manage_payments ON transport_payments
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_payments ON transport_payments
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_payments ON transport_payments
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_notifications: system writes (via Edge Functions), operators/admins can view
CREATE POLICY system_insert_notifications ON transport_notifications
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin', 'driver'));

CREATE POLICY operator_manage_notifications ON transport_notifications
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_notifications ON transport_notifications
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_whatsapp_messages: system writes, operators/admins can view
CREATE POLICY system_insert_whatsapp ON transport_whatsapp_messages
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_manage_whatsapp ON transport_whatsapp_messages
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_whatsapp ON transport_whatsapp_messages
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- transport_school_closures: write restricted to operator/admin
CREATE POLICY operator_manage_closures ON transport_school_closures
    FOR INSERT WITH CHECK (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_update_closures ON transport_school_closures
    FOR UPDATE USING (public.get_user_role() IN ('operator', 'admin'));

CREATE POLICY operator_delete_closures ON transport_school_closures
    FOR DELETE USING (public.get_user_role() IN ('operator', 'admin'));

-- =============================================================================
-- AUDIT LOG POLICIES
-- INSERT: all authenticated users (system writes audit entries)
-- SELECT: only operators and admins
-- =============================================================================
CREATE POLICY audit_log_insert ON transport_audit_log
    FOR INSERT WITH CHECK (true);

CREATE POLICY audit_log_select ON transport_audit_log
    FOR SELECT USING (public.get_user_role() IN ('operator', 'admin'));

-- No UPDATE or DELETE on audit log (immutable)

-- =============================================================================
-- VENDOR ADMIN POLICIES (platform-level access)
-- Requirement 13.4: Vendor admin access via RLS
-- vendor_admin role can access all tenant data for platform administration
-- =============================================================================
CREATE POLICY vendor_admin_access_vehicles ON transport_vehicles
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_routes ON transport_routes
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_stops ON transport_stops
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_students ON transport_students
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_guardians ON transport_guardians
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_student_guardians ON transport_student_guardians
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_schedules ON transport_schedules
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_trips ON transport_trips
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_attendance ON transport_attendance
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_locations ON transport_trip_locations
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_invoices ON transport_invoices
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_payments ON transport_payments
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_notifications ON transport_notifications
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_whatsapp ON transport_whatsapp_messages
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_closures ON transport_school_closures
    FOR ALL USING (public.get_user_role() = 'vendor_admin');

CREATE POLICY vendor_admin_access_audit_log ON transport_audit_log
    FOR ALL USING (public.get_user_role() = 'vendor_admin');
