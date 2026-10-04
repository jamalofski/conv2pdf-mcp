# Changelog

## 1.0.0 (unreleased)

First release.

- Thirteen tools: `convert_to_pdf` (Office documents, Apple Pages, images, HEIC photos and EPUB e-books, chosen from the extension), `convert_heic_to_jpg`, `convert_pdf_to_word`, `convert_pdf_to_images`, `merge_pdfs`, `extract_pdf_pages`, `rotate_pdf`, `add_page_numbers`, `add_watermark`, `compress_pdf`, `protect_pdf`, `unlock_pdf` and `get_quota`.
- A tool reads the file at the path it is given, writes the result next to it or at `output_path`, never overwrites a file, and deletes the job from the conv2pdf server once the result is on disk.
- The tools that read a PDF, except `merge_pdfs`, open one that asks for a password when it is passed as `password`.
- Waits for `Retry-After` when the API rate-limits the key or its queue is full, twice at most and for delays of 30 seconds or less.
- stdio transport, no dependency, protocol revisions 2026-07-28 and 2025-11-25 down to 2024-11-05.
