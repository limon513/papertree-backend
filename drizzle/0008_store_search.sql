CREATE TABLE "product_search" (
	"product_id" bigint PRIMARY KEY NOT NULL,
	"doc" text NOT NULL,
	"tsv" "tsvector" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_queries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"query" text NOT NULL,
	"results" integer NOT NULL,
	"corrected_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_synonyms" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_synonyms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"terms" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_search" ADD CONSTRAINT "product_search_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_search_tsv_idx" ON "product_search" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_queries_created_at_idx" ON "search_queries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "search_queries_query_idx" ON "search_queries" USING btree (lower("query"));--> statement-breakpoint
-- Rebuild one product's search row: name, brand, categories (with their parents), tags, SKUs, short description.
CREATE OR REPLACE FUNCTION refresh_product_search(pid bigint) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  p_name text; p_brand text; p_tags text; p_desc text; p_cats text; p_skus text;
BEGIN
  SELECT p.name, coalesce(b.name, ''), array_to_string(p.tags, ' '), coalesce(p.short_description, '')
    INTO p_name, p_brand, p_tags, p_desc
    FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id = pid;
  IF NOT FOUND THEN
    DELETE FROM product_search WHERE product_id = pid;
    RETURN;
  END IF;
  WITH RECURSIVE up AS (
    SELECT c.id, c.parent_id, c.name FROM product_categories pc JOIN categories c ON c.id = pc.category_id WHERE pc.product_id = pid
    UNION
    SELECT c.id, c.parent_id, c.name FROM categories c JOIN up ON c.id = up.parent_id
  )
  SELECT coalesce(string_agg(DISTINCT up.name, ' '), '') INTO p_cats FROM up;
  SELECT coalesce(string_agg(v.sku, ' '), '') INTO p_skus FROM product_variants v WHERE v.product_id = pid AND v.sku IS NOT NULL;
  INSERT INTO product_search (product_id, doc, tsv, updated_at)
  VALUES (
    pid,
    lower(concat_ws(' ', p_name, p_brand, p_cats, p_tags, p_skus)),
    setweight(to_tsvector('english', p_name) || to_tsvector('simple', p_name), 'A')
      || setweight(to_tsvector('english', p_brand || ' ' || p_cats) || to_tsvector('simple', p_brand || ' ' || p_cats), 'B')
      || setweight(to_tsvector('english', p_tags) || to_tsvector('simple', p_tags || ' ' || p_skus), 'C')
      || setweight(to_tsvector('english', p_desc), 'D'),
    now()
  )
  ON CONFLICT (product_id) DO UPDATE SET doc = excluded.doc, tsv = excluded.tsv, updated_at = now();
END
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION product_search_on_product() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM refresh_product_search(NEW.id);
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER product_search_on_product AFTER INSERT OR UPDATE OF name, brand_id, tags, short_description ON products
  FOR EACH ROW EXECUTE FUNCTION product_search_on_product();
--> statement-breakpoint
-- Variants (SKUs) and category links: refresh their product.
CREATE OR REPLACE FUNCTION product_search_on_child() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM refresh_product_search(OLD.product_id); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.product_id <> OLD.product_id) THEN PERFORM refresh_product_search(NEW.product_id); END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER product_search_on_variant AFTER INSERT OR DELETE OR UPDATE OF sku, product_id ON product_variants
  FOR EACH ROW EXECUTE FUNCTION product_search_on_child();
--> statement-breakpoint
CREATE TRIGGER product_search_on_category_link AFTER INSERT OR DELETE OR UPDATE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION product_search_on_child();
--> statement-breakpoint
-- A brand renamed: all its products.
CREATE OR REPLACE FUNCTION product_search_on_brand() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM refresh_product_search(p.id) FROM products p WHERE p.brand_id = NEW.id;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER product_search_on_brand AFTER UPDATE OF name ON brands
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION product_search_on_brand();
--> statement-breakpoint
-- A category renamed or moved: products in it and in its sub-categories.
CREATE OR REPLACE FUNCTION product_search_on_category() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM refresh_product_search(x.product_id) FROM (
    WITH RECURSIVE down AS (
      SELECT NEW.id AS id
      UNION
      SELECT c.id FROM categories c JOIN down ON c.parent_id = down.id
    )
    SELECT DISTINCT pc.product_id FROM product_categories pc JOIN down ON pc.category_id = down.id
  ) x;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER product_search_on_category AFTER UPDATE OF name, parent_id ON categories
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.parent_id IS DISTINCT FROM NEW.parent_id)
  EXECUTE FUNCTION product_search_on_category();
--> statement-breakpoint
-- Products that already exist.
SELECT refresh_product_search(id) FROM products;
--> statement-breakpoint
-- Starting synonyms: Banglish, Bangla, British/American spelling and common misspellings. Editable in the admin.
INSERT INTO search_synonyms (terms) VALUES
  (ARRAY['notebook', 'note book', 'exercise book', 'copy', 'khata', 'khatha', 'khaata', 'খাতা']),
  (ARRAY['pen', 'ball pen', 'ballpen', 'kolom', 'kalam', 'কলম']),
  (ARRAY['pencil', 'pensil', 'pencel', 'পেন্সিল']),
  (ARRAY['paper', 'kagoj', 'kagaj', 'kagoz', 'কাগজ']),
  (ARRAY['colour', 'color', 'rong', 'rang', 'রং', 'রঙ']),
  (ARRAY['eraser', 'rubber', 'rabar', 'রাবার']),
  (ARRAY['sharpener', 'sharpner', 'sharpenar', 'কাটার']),
  (ARRAY['ruler', 'scale', 'স্কেল']),
  (ARRAY['glue', 'gum', 'adhesive', 'atha', 'আঠা']),
  (ARRAY['diary', 'dairy', 'ডায়েরি']),
  (ARRAY['sketchbook', 'sketch book', 'drawing book', 'drawing khata']),
  (ARRAY['geometry box', 'geometry set', 'instrument box', 'compass box']),
  (ARRAY['pencil box', 'pencil case', 'pencil pouch']),
  (ARRAY['scissors', 'scissor', 'kachi', 'kechi', 'kenchi', 'কাঁচি']),
  (ARRAY['stapler', 'stepler', 'stapeler']),
  (ARRAY['watercolour', 'watercolor', 'water colour', 'water color']),
  (ARRAY['tape', 'cello tape', 'sellotape', 'scotch tape']),
  (ARRAY['envelope', 'khaam', 'kham', 'খাম']),
  (ARRAY['calculator', 'calculater', 'calculetor']),
  (ARRAY['highlighter', 'hilighter', 'highliter']),
  (ARRAY['marker', 'markar', 'sign pen']);
