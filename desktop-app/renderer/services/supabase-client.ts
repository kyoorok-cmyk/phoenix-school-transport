import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (window as any).phoenixConfig?.supabaseUrl || 'https://your-project.supabase.co';
const supabaseAnonKey = (window as any).phoenixConfig?.supabaseAnonKey || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
