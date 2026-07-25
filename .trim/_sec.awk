/^#/ { if (h!="") printf "%s\t%d\n", h, n; h=$0; n=0; next }
{ n+=NF }
END { if (h!="") printf "%s\t%d\n", h, n }
