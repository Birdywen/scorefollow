"""Parse synpdf preload.js files and extract ground truth timing arrays.

Usage: python3 scripts/parse-preload.py <preload.js>
Output: JSON with pdf_file, times_arr, adv_settings
"""
import re
import json
import sys
from pathlib import Path

def parse_preload(text):
    """Extract variables from synpdf preload format."""
    result = {}
    
    # pdf_file = "path";
    m = re.search(r'pdf_file\s*=\s*"([^"]*)"', text)
    if m:
        result['pdf_file'] = m.group(1)
    
    # media_file = "path";
    m = re.search(r'media_file\s*=\s*"([^"]*)"', text)
    if m:
        result['media_file'] = m.group(1)
    
    # times_arr = [...];
    m = re.search(r'times_arr\s*=\s*(\[[^\]]*\]);', text, re.DOTALL)
    if m:
        result['times_arr'] = json.loads(m.group(1))
    
    # offset_js = 0;
    m = re.search(r'offset_js\s*=\s*([\d.-]+);', text)
    if m:
        result['offset_js'] = float(m.group(1))
    
    # adv_settings = {...};
    m = re.search(r'adv_settings\s*=\s*(\{[^}]*\});', text, re.DOTALL)
    if m:
        result['adv_settings'] = json.loads(m.group(1))
    
    return result

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/parse-preload.py <preload.js>')
        sys.exit(1)
    
    path = Path(sys.argv[1])
    text = path.read_text()
    data = parse_preload(text)
    
    if 'times_arr' in data:
        print(f"Parsed {path.name}:")
        print(f"  PDF: {data.get('pdf_file', 'N/A')}")
        print(f"  Times: {len(data['times_arr'])} entries")
        print(f"  Settings: {list(data.get('adv_settings', {}).keys())}")
        
        # Convert to standard format
        out = {
            'source': str(path),
            'pdf': data.get('pdf_file'),
            'media': data.get('media_file'),
            'offset': data.get('offset_js', 0),
            'settings': data.get('adv_settings', {}),
            'timing': data['times_arr'],
        }
        
        out_path = path.parent / (path.stem + '_parsed.json')
        out_path.write_text(json.dumps(out, indent=2))
        print(f"  Saved: {out_path}")
    else:
        print(f"ERROR: No times_arr found in {path}")
        sys.exit(1)
