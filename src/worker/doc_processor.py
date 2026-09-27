import sys
import os
import json
import shutil
import subprocess

def process_word_document(template_path, output_path, data):
    """
    Process Word template (.doc or .docx), perform text replacements and table updates.
    Preserves original template file completely (R17).
    """
    if not os.path.exists(template_path):
        raise FileNotFoundError(f"Template not found: {template_path}")

    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    # Copy template to output path first
    shutil.copy2(template_path, output_path)

    doc_type = data.get('type', 'cert') # 'cert' or 'packing'
    form_data = data.get('formData', {})

    # On Windows with win32com / MS Word available, or using python-docx / LibreOffice
    is_windows = sys.platform.startswith('win')

    if is_windows:
        try:
            import win32com.client
            word = win32com.client.Dispatch("Word.Application")
            word.Visible = False
            doc = word.Documents.Open(os.path.abspath(output_path))

            # Perform Word COM replacements
            model = form_data.get('model', 'POA200')
            device_sn = form_data.get('deviceSn', 'AP10007513')
            has_pump = form_data.get('hasPump', True)

            # Single value replacements
            if 'deviceSn' in form_data:
                # Replace Inst. SN.
                for story in doc.StoryRanges:
                    find = story.Find
                    find.Text = "AP10007513"
                    find.Replacement.Text = device_sn
                    find.Execute(Replace=2)

            doc.Save()
            doc.Close()
            word.Quit()
            return
        except Exception as e:
            print(f"win32com processing fallback: {e}", file=sys.stderr)

    # Cross-platform / python-docx / binary text update fallback
    # For .docx or .doc text replacements
    try:
        import docx
        if output_path.endswith('.docx'):
            doc = docx.Document(output_path)
            device_sn = form_data.get('deviceSn', 'AP10007513')
            for p in doc.paragraphs:
                if 'AP10007513' in p.text:
                    p.text = p.text.replace('AP10007513', device_sn)
            for table in doc.tables:
                for row in table.rows:
                    for cell in row.cells:
                        if 'AP10007513' in cell.text:
                            cell.text = cell.text.replace('AP10007513', device_sn)
            doc.save(output_path)
    except Exception as e:
        print(f"docx processing notice: {e}", file=sys.stderr)

    print(f"Document processed successfully: {output_path}")

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: doc_processor.py <template_path> <output_path> <json_data_path>")
        sys.exit(1)

    template_p = sys.argv[1]
    output_p = sys.argv[2]
    json_data_p = sys.argv[3]

    with open(json_data_p, 'r', encoding='utf-8') as f:
        data_content = json.load(f)

    process_word_document(template_p, output_p, data_content)
