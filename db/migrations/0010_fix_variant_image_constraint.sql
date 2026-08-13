ALTER TABLE variants DROP CONSTRAINT variants_image_path_check;

ALTER TABLE variants
  ADD CONSTRAINT variants_image_path_check
  CHECK (image IS NULL OR (image LIKE '/img/products/%' AND image !~ '[[:cntrl:]]'));
