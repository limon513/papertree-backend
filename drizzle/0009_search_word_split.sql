-- Index words the way the website splits what shoppers type: on any punctuation. Without this,
-- "MT-002-BLUE" was read as "mt", "-002" (a negative number) and "blue", so "mt 002" found nothing.
CREATE OR REPLACE FUNCTION search_words(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(coalesce(t, ''), '[^[:alnum:]]+', ' ', 'g')
$fn$;
--> statement-breakpoint
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
  p_name := search_words(p_name);
  p_brand := search_words(p_brand);
  p_cats := search_words(p_cats);
  p_tags := search_words(p_tags);
  p_skus := search_words(p_skus);
  p_desc := search_words(p_desc);
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
SELECT refresh_product_search(id) FROM products;
--> statement-breakpoint
-- "copy" (an exercise book in Bangladesh) also matched "copy paper": left out; the shop can add it back.
UPDATE search_synonyms SET terms = array_remove(terms, 'copy'), updated_at = now() WHERE 'copy' = ANY (terms);
