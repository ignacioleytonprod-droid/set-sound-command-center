-- Caja Chica (CELL_02). Run this in the Supabase SQL Editor.
-- Backend access uses the Supabase service-role key stored only in Render.
-- RLS is enabled and no browser/public policies are created.

CREATE TABLE IF NOT EXISTS public.caja_chica (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  concepto TEXT NOT NULL CHECK (char_length(btrim(concepto)) BETWEEN 1 AND 500),
  categoria TEXT NOT NULL DEFAULT 'General' CHECK (char_length(btrim(categoria)) BETWEEN 1 AND 100),
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
  monto NUMERIC(12, 2) NOT NULL CHECK (monto > 0),
  celula TEXT NOT NULL DEFAULT 'CELL_02' CHECK (celula IN ('CELL_01', 'CELL_02', 'CELL_03', 'CELL_04')),
  evento_id TEXT NULL CHECK (evento_id IS NULL OR char_length(evento_id) <= 160),
  comprobante_url TEXT NULL CHECK (comprobante_url IS NULL OR char_length(comprobante_url) <= 2048),
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS caja_chica_creado_en_idx
  ON public.caja_chica (creado_en DESC);
CREATE INDEX IF NOT EXISTS caja_chica_fecha_idx
  ON public.caja_chica (fecha DESC);
CREATE INDEX IF NOT EXISTS caja_chica_celula_fecha_idx
  ON public.caja_chica (celula, fecha DESC);

ALTER TABLE public.caja_chica ENABLE ROW LEVEL SECURITY;

-- Keep browser roles from accessing this financial table directly.
REVOKE ALL ON TABLE public.caja_chica FROM anon, authenticated;
GRANT ALL ON TABLE public.caja_chica TO service_role;
