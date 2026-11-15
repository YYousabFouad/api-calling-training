"use strict";

const btn = document.querySelector(".btn-country");
const countriesContainer = document.querySelector(".countries");

// NEW REVERSE GEOCODING API URL (use instead of the URL shown in videos):
// https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}

///////////////////////////////////////

const request = new XMLHttpRequest();
request.open("GET", "http://127.0.0.1:3000/api/countries");

request.addEventListener("load", function () {
  if (this.status < 200 || this.status >= 300) {
    console.error(
      `Request failed with status ${this.status}:`,
      this.responseText,
    );
    return;
  }

  try {
    const data = JSON.parse(this.responseText);
    console.log(data);
  } catch (error) {
    console.error("Failed to parse JSON response:", error);
  }
});

request.addEventListener("error", function () {
  console.error("Network error occurred while making the request.");
});

request.send();
