import os

def split_file(input_filepath, output_dir, num_files=12):
    """
    Splits a large CSV file into multiple smaller files.
    Each smaller file will contain the header from the original file.
    """
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    with open(input_filepath, 'r') as f_in:
        header = f_in.readline()
        lines = f_in.readlines()

    total_lines = len(lines)
    lines_per_file = total_lines // num_files
    
    print(f"Splitting {input_filepath} into {num_files} files.")
    print(f"Total lines (excluding header): {total_lines}")
    print(f"Lines per file: {lines_per_file}")

    for i in range(num_files):
        output_filename = os.path.join(output_dir, f"stop_times_part_{i+1}.txt")
        start_index = i * lines_per_file
        end_index = (i + 1) * lines_per_file
        
        # Ensure the last file gets any remaining lines
        if i == num_files - 1:
            end_index = total_lines

        with open(output_filename, 'w') as f_out:
            f_out.write(header)
            for line in lines[start_index:end_index]:
                f_out.write(line)
        print(f"Created {output_filename} with {end_index - start_index} lines (excluding header).")

if __name__ == "__main__":
    input_file = "/Users/adamsterling/Downloads/CSC316-A4proto/static_data/stop_times.txt"
    output_directory = "/Users/adamsterling/Downloads/CSC316-A4proto/static_data/"
    split_file(input_file, output_directory)
