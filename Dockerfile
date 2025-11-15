# 1. Base Image
# Gunakan image Python 3.10-slim sebagai dasar yang ringan
FROM python:3.10-slim

# 2. Set Working Directory
# Tetapkan direktori kerja di dalam container
WORKDIR /app

# 3. Install Dependencies
# Salin file requirements.txt terlebih dahulu untuk memanfaatkan Docker cache
COPY requirements.txt .
# Install library. --no-cache-dir mengurangi ukuran image
RUN pip install --no-cache-dir -r requirements.txt

# 4. Copy Application Code
# Salin semua file dari direktori lokal (saat ini) ke direktori /app di container
COPY . .

# 5. Expose Port
# Port default Streamlit adalah 8501. Sesuai permintaan Anda (+10),
# kita akan menggunakan port 8511.
EXPOSE 8511

# 6. Command to Run
# Jalankan Streamlit pada port 8511.
# --server.enableCORS=false direkomendasikan saat berjalan di balik proxy/docker
CMD ["streamlit", "run", "bpjs-healthkathon-prototype.py", "--server.port", "8511", "--server.enableCORS", "false"]