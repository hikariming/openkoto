use crate::types::Article;
use quick_xml::{events::Event, Reader};
use regex::Regex;
use std::{collections::HashMap, fs::File, io::Read, path::Path};
use zip::ZipArchive;

const LEGACY_EPUB_PLACEHOLDER_PREFIX: &str = "[EPUB 书籍]";
const MAX_EPUB_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const MAX_EPUB_CHAPTER_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EPUB_TEXT_CHARS: usize = 4_000_000;

#[derive(Debug)]
struct ManifestItem {
    id: String,
    href: String,
    media_type: String,
}

pub fn resolve_mind_map_content(article: &Article) -> Result<String, String> {
    let is_epub = article.book_type.as_deref() == Some("epub");
    let stored_content = article.content.trim();
    let needs_extraction = is_epub
        && (stored_content.is_empty()
            || stored_content.starts_with(LEGACY_EPUB_PLACEHOLDER_PREFIX));

    if !needs_extraction {
        return Ok(article.content.clone());
    }

    let book_path = article
        .book_path
        .as_deref()
        .ok_or_else(|| "Cannot generate mind map: EPUB file path is missing".to_string())?;

    extract_epub_text(Path::new(book_path)).map_err(|error| {
        format!(
            "Cannot generate mind map: failed to extract EPUB text from {}: {}",
            book_path, error
        )
    })
}

fn extract_epub_text(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("could not open file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("invalid EPUB archive: {error}"))?;

    let container_xml = read_archive_text(
        &mut archive,
        "META-INF/container.xml",
        MAX_EPUB_METADATA_BYTES,
    )?;
    let package_path = parse_package_path(&container_xml)
        .ok_or_else(|| "META-INF/container.xml has no rootfile path".to_string())?;
    let package_path = normalize_archive_path("", &package_path)?;
    let package_xml = read_archive_text(&mut archive, &package_path, MAX_EPUB_METADATA_BYTES)?;
    let (manifest, spine) = parse_package_document(&package_xml);

    if manifest.is_empty() {
        return Err("EPUB package manifest is empty".to_string());
    }

    let package_dir = package_path
        .rsplit_once('/')
        .map(|(directory, _)| directory)
        .unwrap_or("");
    let manifest_by_id: HashMap<&str, &ManifestItem> = manifest
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let ordered_items: Vec<&ManifestItem> = if spine.is_empty() {
        manifest.iter().filter(|item| is_html_item(item)).collect()
    } else {
        spine
            .iter()
            .filter_map(|id| manifest_by_id.get(id.as_str()).copied())
            .filter(|item| is_html_item(item))
            .collect()
    };

    if ordered_items.is_empty() {
        return Err("EPUB package spine contains no readable HTML documents".to_string());
    }

    let mut content = String::new();
    let mut content_chars = 0;
    for item in ordered_items {
        let entry_path = normalize_archive_path(package_dir, &item.href)?;
        let html = read_archive_text(&mut archive, &entry_path, MAX_EPUB_CHAPTER_BYTES)?;
        let text = html_document_to_text(&html);
        if !text.is_empty() {
            let text_chars = text.chars().count();
            let separator_chars = if content.is_empty() { 0 } else { 2 };
            if content_chars + separator_chars + text_chars > MAX_EPUB_TEXT_CHARS {
                return Err(format!(
                    "EPUB text exceeds the supported size of {MAX_EPUB_TEXT_CHARS} characters"
                ));
            }
            if !content.is_empty() {
                content.push_str("\n\n");
            }
            content.push_str(&text);
            content_chars += separator_chars + text_chars;
        }
    }

    if content.trim().is_empty() {
        return Err("EPUB reading order contains no extractable text".to_string());
    }

    Ok(content)
}

fn read_archive_text(
    archive: &mut ZipArchive<File>,
    name: &str,
    max_bytes: u64,
) -> Result<String, String> {
    let entry = archive
        .by_name(name)
        .map_err(|error| format!("missing archive entry {name}: {error}"))?;
    if entry.size() > max_bytes {
        return Err(format!(
            "archive entry {name} exceeds the supported size of {max_bytes} bytes"
        ));
    }
    let mut bytes = Vec::new();
    entry
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read archive entry {name}: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "archive entry {name} exceeds the supported size of {max_bytes} bytes"
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn parse_package_path(container_xml: &str) -> Option<String> {
    let mut reader = Reader::from_str(container_xml);
    reader.config_mut().trim_text(true);

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if local_name(element.name().as_ref()) == b"rootfile" =>
            {
                if let Some(path) = attribute_value(&element, b"full-path") {
                    return Some(path);
                }
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

fn parse_package_document(package_xml: &str) -> (Vec<ManifestItem>, Vec<String>) {
    let mut reader = Reader::from_str(package_xml);
    reader.config_mut().trim_text(true);
    let mut manifest = Vec::new();
    let mut spine = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                match local_name(element.name().as_ref()) {
                    b"item" => {
                        let id = attribute_value(&element, b"id");
                        let href = attribute_value(&element, b"href");
                        let media_type = attribute_value(&element, b"media-type");
                        if let (Some(id), Some(href), Some(media_type)) = (id, href, media_type) {
                            manifest.push(ManifestItem {
                                id,
                                href,
                                media_type,
                            });
                        }
                    }
                    b"itemref" => {
                        let linear = attribute_value(&element, b"linear");
                        if linear.as_deref() != Some("no") {
                            if let Some(idref) = attribute_value(&element, b"idref") {
                                spine.push(idref);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    (manifest, spine)
}

fn attribute_value(element: &quick_xml::events::BytesStart<'_>, name: &[u8]) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| local_name(attribute.key.as_ref()) == name)
        .and_then(|attribute| {
            std::str::from_utf8(attribute.value.as_ref())
                .ok()
                .map(|value| html_escape::decode_html_entities(value).into_owned())
        })
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn is_html_item(item: &ManifestItem) -> bool {
    matches!(
        item.media_type.as_str(),
        "application/xhtml+xml" | "text/html"
    )
}

fn normalize_archive_path(base_dir: &str, href: &str) -> Result<String, String> {
    let href = href.split(['#', '?']).next().unwrap_or("").trim();
    let decoded = urlencoding::decode(href)
        .map_err(|error| format!("invalid percent-encoding in EPUB path {href}: {error}"))?;
    let decoded = decoded.replace('\\', "/");
    let mut parts: Vec<&str> = if decoded.starts_with('/') {
        Vec::new()
    } else {
        base_dir
            .split('/')
            .filter(|part| !part.is_empty())
            .collect()
    };

    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(format!("EPUB path escapes archive root: {href}"));
                }
            }
            value => parts.push(value),
        }
    }

    if parts.is_empty() {
        return Err(format!("EPUB path is empty: {href}"));
    }

    Ok(parts.join("/"))
}

fn html_document_to_text(html: &str) -> String {
    let unsafe_blocks = Regex::new(
        r"(?is)<script\b[^>]*>.*?</script\s*>|<style\b[^>]*>.*?</style\s*>|<svg\b[^>]*>.*?</svg\s*>",
    )
    .expect("valid EPUB cleanup regex");
    let cleaned = unsafe_blocks.replace_all(html, " ");
    let normalized = cleaned.replace(['\r', '\n'], " ");
    let line_breaks = Regex::new(r"(?i)<br\s*/?>")
        .expect("valid line break regex")
        .replace_all(&normalized, "\n");
    let block_starts = Regex::new(
        r"(?i)<(article|aside|blockquote|div|figcaption|figure|h[1-6]|li|main|ol|p|pre|section|table|tr|ul)\b[^>]*>",
    )
    .expect("valid block start regex")
    .replace_all(&line_breaks, "\n");
    let block_ends = Regex::new(
        r"(?i)</(article|aside|blockquote|div|figcaption|figure|h[1-6]|li|main|ol|p|pre|section|table|tr|ul)\s*>",
    )
    .expect("valid block end regex")
    .replace_all(&block_starts, "\n");
    let without_tags = Regex::new(r"<[^>]*>")
        .expect("valid tag regex")
        .replace_all(&block_ends, "");
    let decoded = html_escape::decode_html_entities(&without_tags);

    decoded
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::normalize_archive_path;

    #[test]
    fn archive_paths_resolve_relative_segments_and_percent_encoding() {
        assert_eq!(
            normalize_archive_path("OEBPS/package", "../Text/chapter%201.xhtml").unwrap(),
            "OEBPS/Text/chapter 1.xhtml"
        );
        assert!(normalize_archive_path("", "../../outside.xhtml").is_err());
    }
}
