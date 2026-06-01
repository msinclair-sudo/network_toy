"""
Domain-specific abbreviation expansion, applied BEFORE SPECTER2 embedding.

Consolidated home for ALL normalisation the ingest does (ported from the old
literture-network pipeline: functions from pipeline/utils/text_normalization.py
and the ABBREVIATION_MAP / CONTEXT_DISAMBIG dicts from pipeline/config.py, baked
in so this module is self-contained -- no external config dependency).
The dicts below are generated verbatim from config.py -- do not hand-edit.

Expanding abbreviations before embedding stops SPECTER2 from treating e.g.
"amf" and "arbuscular mycorrhizal fungi" as unrelated tokens.

CAVEAT -- tuned for ONE domain (soil contamination / agronomy / soil
microbiology). ABBREVIATION_MAP entries always fire; CONTEXT_DISAMBIG entries
only fire when domain context words co-occur in the document. For a different
field, run embed_specter2.py with --no-normalize.
"""
import re
from typing import Set, List

ABBREVIATION_MAP = {'cd': 'cadmium',
 'pb': 'lead',
 'zn': 'zinc',
 'cu': 'copper',
 'ni': 'nickel',
 'cr': 'chromium',
 'hg': 'mercury',
 'as': 'arsenic',
 'mn': 'manganese',
 'fe': 'iron',
 'ca': 'calcium',
 'nt': 'no-tillage',
 'ct': 'conventional tillage',
 'rt': 'reduced tillage',
 'soc': 'soil organic carbon',
 'doc': 'dissolved organic carbon',
 'poc': 'particulate organic carbon',
 'mic': 'microbial biomass carbon',
 'mb': 'microbial biomass',
 'tn': 'total nitrogen',
 'don': 'dissolved organic nitrogen',
 'amf': 'arbuscular mycorrhizal fungi',
 'pgpb': 'plant growth promoting bacteria',
 'pgpr': 'plant growth promoting rhizobacteria',
 'amoa': 'ammonia monooxygenase',
 'nifh': 'nitrogenase',
 'nirs': 'nitrite reductase',
 'nirk': 'nitrite reductase',
 'nosz': 'nitrous oxide reductase',
 'otu': 'operational taxonomic unit',
 'asv': 'amplicon sequence variant',
 'pcr': 'PCR',
 'qpcr': 'quantitative PCR',
 'dgge': 'denaturing gradient gel electrophoresis',
 'trflp': 'terminal restriction fragment length polymorphism',
 'no3': 'nitrate',
 'nh4': 'ammonium',
 'n2o': 'nitrous oxide',
 'ha': 'hectare',
 'crp': 'Conservation Reserve Program',
 'pi': 'inorganic phosphate',
 'ja': 'jasmonic acid',
 'ck': 'cytokinin',
 'amd': 'acid mine drainage',
 'na': 'not applicable',
 'nd': 'not detected',
 'co2': 'carbon dioxide',
 'ch4': 'methane',
 'po4': 'phosphate'}

CONTEXT_DISAMBIG = {'cr': [(['contamination', 'metal', 'mining', 'tailings', 'cd', 'pb', 'zn'],
         'chromium'),
        (['residue', 'crop', 'straw', 'tillage'], 'crop residue')],
 'nt': [(['tillage', 'straw', 'conservation', 'ct', 'wheat', 'maize'], 'no-tillage'),
        (['nitrogen', 'treatment', 'fertilizer'], 'nitrogen treatment')],
 'c': [(['cycling', 'sequestration', 'storage', 'soc'], 'carbon')],
 'n': [(['cycling', 'fixation', 'mineralization', 'availability'], 'nitrogen')],
 'bc': [(['pyrolysis', 'amendment', 'charcoal', 'biochar', 'carbon'], 'biochar'),
        (['bacterial', 'microbial', 'diversity', 'composition'],
         'bacterial community')],
 'ag': [(['nanoparticle', 'metal', 'silver', 'antimicrobial', 'nanoparticles'],
         'silver'),
        (['farming', 'crop', 'field', 'management', 'agriculture'], 'agricultural')],
 'ar': [(['arid', 'desert', 'dryland', 'precipitation', 'semiarid'], 'arid'),
        (['aromatic', 'compound', 'compounds', 'benzene', 'hydrocarbon', 'organic'],
         'aromatic')],
 'gm': [(['genetically', 'modified', 'transgenic', 'gmo', 'genetic'],
         'genetically modified')]}


def expand_abbreviation_in_context(word: str, context_terms: Set[str]) -> str:
    """
    Expand a single word using context-aware disambiguation.

    Args:
        word: The word to potentially expand
        context_terms: Set of all words in the surrounding text (lowercased)

    Returns:
        Expanded word or original if no expansion applies
    """
    word_lower = word.lower()

    # First, check context-dependent disambiguation
    if word_lower in CONTEXT_DISAMBIG:
        for context_keywords, expansion in CONTEXT_DISAMBIG[word_lower]:
            # Check if any context keyword appears in the text
            if any(kw in context_terms for kw in context_keywords):
                return expansion

    # Fallback to standard abbreviation expansion
    if word_lower in ABBREVIATION_MAP:
        return ABBREVIATION_MAP[word_lower]

    # No expansion found - return original word
    return word


def normalize_text(text: str, preserve_case: bool = False, track_expansions: bool = False):
    """
    Normalize text by expanding abbreviations and disambiguating based on context.

    This function prepares text for embedding by ensuring semantic consistency:
    - "cd contamination" → "cadmium contamination"
    - "amf diversity" → "arbuscular mycorrhizal fungi diversity"
    - "cr metal soil" → "chromium metal soil" (context: metal)
    - "cr residue tillage" → "crop residue residue tillage" (context: tillage)

    The plain one-argument call -- normalize_text(text) -- is what
    embed_specter2.py uses; the keyword args are opt-in extras.

    Args:
        text: Raw text to normalize (title, abstract, etc.)
        preserve_case: If True, attempt to preserve original case (default: False)
        track_expansions: If True, return (normalized_text, expansions_list) (default: False)

    Returns:
        If track_expansions=False: Normalized text with abbreviations expanded
        If track_expansions=True: Tuple of (normalized_text, list of (original, expanded) tuples)
    """
    if not text:
        return (text, []) if track_expansions else text

    # Tokenize into words (simple whitespace split, preserving punctuation)
    words = text.split()

    # Build context set from all words in the text (lowercased for matching)
    context_terms = {w.lower().strip('.,;:!?()[]{}"\'-') for w in words}

    # Expand each word
    normalized_words = []
    expansions = [] if track_expansions else None

    for word in words:
        # Check if word is purely punctuation
        if not re.search(r'\w', word):
            normalized_words.append(word)
            continue

        # Split word into alpha part and trailing punctuation
        match = re.match(r'([\w]+)(.*)', word)
        if not match:
            normalized_words.append(word)
            continue

        word_part = match.group(1)
        punct_part = match.group(2)

        # Expand the alpha part
        expanded = expand_abbreviation_in_context(word_part, context_terms)

        # Track if expansion occurred
        if track_expansions and expanded.lower() != word_part.lower():
            expansions.append((word_part.lower(), expanded.lower()))

        # Preserve case if requested (simple heuristic)
        if preserve_case:
            if word_part.isupper():
                expanded = expanded.upper()
            elif word_part[0].isupper():
                expanded = expanded.capitalize()

        # Reconstruct with punctuation
        normalized_words.append(expanded + punct_part)

    normalized_text = ' '.join(normalized_words)

    if track_expansions:
        return normalized_text, expansions
    else:
        return normalized_text


def normalize_paper_text(paper: dict) -> dict:
    """
    Normalize all text fields in a paper dictionary.

    Applies abbreviation expansion to title and abstract while preserving
    all other fields.

    Args:
        paper: Paper dictionary with 'title' and 'abstract' fields

    Returns:
        New dictionary with normalized text fields
    """
    normalized = paper.copy()

    if 'title' in paper:
        normalized['title_normalized'] = normalize_text(paper['title'])

    if 'abstract' in paper:
        normalized['abstract_normalized'] = normalize_text(paper['abstract'])

    return normalized


def get_normalization_stats(original_text: str, normalized_text: str) -> dict:
    """
    Calculate statistics about text normalization changes.

    Useful for auditing what abbreviations were expanded.

    Args:
        original_text: Text before normalization
        normalized_text: Text after normalization

    Returns:
        Dictionary with statistics:
        - words_changed: Number of words that were expanded
        - expansions: List of (original, expanded) tuples
        - total_words: Total word count
    """
    orig_words = original_text.lower().split()
    norm_words = normalized_text.lower().split()

    # Find differences
    expansions = []
    words_changed = 0

    for orig, norm in zip(orig_words, norm_words):
        # Strip punctuation for comparison
        orig_clean = orig.strip('.,;:!?()[]{}"\'-')
        norm_clean = norm.strip('.,;:!?()[]{}"\'-')

        if orig_clean != norm_clean and orig_clean:
            expansions.append((orig_clean, norm_clean))
            words_changed += 1

    return {
        'words_changed': words_changed,
        'expansions': expansions,
        'total_words': len(orig_words),
        'change_rate': words_changed / len(orig_words) if orig_words else 0.0
    }


# Batch processing utilities

def normalize_paper_corpus(papers: List[dict], verbose: bool = False) -> List[dict]:
    """
    Normalize an entire corpus of papers.

    Args:
        papers: List of paper dictionaries
        verbose: If True, print statistics about normalization

    Returns:
        List of normalized paper dictionaries with added fields:
        - title_normalized
        - abstract_normalized
    """
    normalized_papers = []
    total_expansions = 0
    total_words = 0

    for paper in papers:
        normalized = normalize_paper_text(paper)
        normalized_papers.append(normalized)

        if verbose and 'abstract' in paper:
            stats = get_normalization_stats(
                paper.get('abstract', ''),
                normalized.get('abstract_normalized', '')
            )
            total_expansions += stats['words_changed']
            total_words += stats['total_words']

    if verbose:
        change_rate = total_expansions / total_words if total_words > 0 else 0
        print(f"Normalized {len(papers)} papers:")
        print(f"  Total words: {total_words:,}")
        print(f"  Words expanded: {total_expansions:,}")
        print(f"  Change rate: {change_rate:.2%}")

    return normalized_papers


def sample_normalization_examples(papers: List[dict], n: int = 5) -> List[dict]:
    """
    Find sample papers where normalization made changes.

    Useful for verifying normalization is working as expected.

    Args:
        papers: List of paper dictionaries
        n: Number of examples to return

    Returns:
        List of dictionaries with before/after examples
    """
    examples = []

    for paper in papers:
        if 'abstract' not in paper:
            continue

        original = paper['abstract']
        normalized, expansions = normalize_text(original, track_expansions=True)

        if expansions:  # Only include if there were actual expansions
            examples.append({
                'paper_id': paper.get('paper_id', 'unknown'),
                'title': paper.get('title', ''),
                'original_snippet': original[:200] + '...',
                'normalized_snippet': normalized[:200] + '...',
                'expansions': expansions[:10],  # First 10 expansions
                'total_changes': len(expansions)
            })

            if len(examples) >= n:
                break

    return examples
