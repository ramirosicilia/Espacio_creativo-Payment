
import { supabase } from "./DB.js"; 

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

async function testInsert() {
  const { data, error } = await supabase
    .from('pagos')
    .insert([{ libro_id: 1, comprador: 'test', estado: 'completado' }])
  console.log({ data, error })
}

testInsert()
