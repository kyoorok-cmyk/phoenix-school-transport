import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://ptskyueshtjjesxeusot.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0c2t5dWVzaHRqamVzeGV1c290Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MTg2OTAsImV4cCI6MjEwMTE5NDY5MH0.P9x4uTU9jvY11OkezvxdQlbGrqdFtXH-ik-Vd00MD2Y';

export const supabaseAdmin = createClient(supabaseUrl, supabaseKey);
